#!/usr/bin/env bash
# Testa as migrações da F2 contra um PostgreSQL descartável.
#
# Não toca no Supabase. Sobe um cluster local, reconstrói o schema a partir de
# db/baseline.sql, aplica 001+002+003, verifica que a RLS isola a carteira e
# que o lançamento de pedido continua funcionando, reverte tudo e confere que
# o banco voltou ao estado anterior.
#
#   npm run test:db
#
# Requer postgresql-16 (initdb/pg_ctl em /usr/lib/postgresql/16/bin).
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
TMP="$(mktemp -d)"
# Socket em caminho curto: o limite do Unix domain socket é 107 bytes.
SOCK="$(mktemp -d /tmp/msq.XXXX)"
EMAIL="fernanda@teste.local"

limpar() {
  "$PGBIN/pg_ctl" -D "$TMP/pgdata" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$TMP" "$SOCK"
}
trap limpar EXIT

falhou=0
ok()   { echo "  ✓ $1"; }
erro() { echo "  ✗ $1"; falhou=1; }

echo "▶ subindo cluster descartável"
"$PGBIN/initdb" -D "$TMP/pgdata" -U postgres --auth=trust >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$TMP/pgdata" -o "-k $SOCK -h ''" -l "$TMP/pg.log" start >/dev/null 2>&1
sleep 1

q()     { psql -h "$SOCK" -U postgres -d f2 -tAc "$1"; }
rodar() { psql -h "$SOCK" -U postgres -d f2 -v ON_ERROR_STOP=1 -q "$@"; }
M="$RAIZ/db/migrations"

psql -h "$SOCK" -U postgres -qc "CREATE DATABASE f2;" >/dev/null
rodar -f "$RAIZ/db/baseline.sql"

echo "▶ 002 recusa rodar sem a usuária em auth.users"
if rodar -v email_representante=naoexiste@teste.local -f "$M/002_carteira.up.sql" >/dev/null 2>&1
then erro "002 aceitou um e-mail inexistente"
else ok "002 aborta se a usuária não existe"; fi

echo "▶ aplicando 001, 002 e 003"
rodar -f "$M/001_papeis.up.sql"
rodar -v email_representante="$EMAIL" -f "$M/002_carteira.up.sql"
rodar -f "$M/003_rls.up.sql"

[ "$(q "SELECT count(*) FROM cliente WHERE representante_id IS NULL")" = "0" ] \
  && ok "todo cliente tem representante" || erro "sobrou cliente sem dono"
[ "$(q "SELECT string_agg(enumlabel,',' ORDER BY enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='perfil_acesso'")" = "ADMIN,REPRESENTANTE" ] \
  && ok "enum virou ADMIN,REPRESENTANTE" || erro "enum não migrou"

echo "▶ a RLS isola a carteira?"
psql -h "$SOCK" -U postgres -d f2 -qtA <<'EOF' > "$TMP/visao.txt" 2>&1
SELECT id AS uid_fer FROM auth.users WHERE email='fernanda@teste.local' \gset
SELECT id AS uid_out FROM auth.users WHERE email='outra@teste.local' \gset
SELECT id AS uid_adm FROM auth.users WHERE email='admin@teste.local' \gset
SET ROLE authenticated;
SET request.jwt.claim.sub = :'uid_fer';
SELECT 'fernanda=' || count(*) FROM cliente;
SET request.jwt.claim.sub = :'uid_out';
SELECT 'outra=' || count(*) FROM cliente;
UPDATE cliente SET nome='invadido';
SELECT 'invadidos=' || count(*) FROM cliente WHERE nome='invadido';
SET request.jwt.claim.sub = :'uid_adm';
SELECT 'admin=' || count(*) FROM cliente;
RESET ROLE;
EOF
grep -q '^fernanda=500$' "$TMP/visao.txt" && ok "representante vê a carteira dela (500)" || erro "representante não vê a própria carteira"
grep -q '^outra=0$'      "$TMP/visao.txt" && ok "outra representante vê 0"               || erro "vazamento entre carteiras"
grep -q '^invadidos=0$'  "$TMP/visao.txt" && ok "não dá para alterar cliente de outra"   || erro "escrita cruzada permitida"
grep -q '^admin=500$'    "$TMP/visao.txt" && ok "admin vê tudo (500)"                    || erro "admin perdeu acesso"

# O achado A2: sem login, ninguém lê a base.
if psql -h "$SOCK" -U postgres -d f2 -qtAc "SET ROLE anon; SELECT count(*) FROM cliente;" >/dev/null 2>&1
then erro "ANÔNIMO AINDA LÊ A BASE — achado A2 aberto"
else ok "anônimo barrado (achado A2 fechado)"; fi

echo "▶ o representante ainda consegue lançar pedido?"
# Sem o patch de salvar_pedido, a política de INSERT rejeita: usuario_id fica NULL.
psql -h "$SOCK" -U postgres -d f2 -qtA <<'EOF' > "$TMP/pedido.txt" 2>&1
SELECT id AS uid_fer FROM auth.users WHERE email='fernanda@teste.local' \gset
SELECT id AS cli FROM cliente ORDER BY id LIMIT 1 \gset
SELECT id AS prod FROM produto ORDER BY id LIMIT 1 \gset
SET ROLE authenticated;
SET request.jwt.claim.sub = :'uid_fer';
SELECT 'pedido=' || (salvar_pedido(
  jsonb_build_object('cliente_id', :'cli'),
  jsonb_build_array(jsonb_build_object(
    'produto_id', :'prod', 'descricao', 'teste',
    'quantidade', 2, 'preco_unit', 100))
)->>'numero');
SELECT 'autoria=' || count(*) FROM pedido WHERE usuario_id = auth.uid();
RESET ROLE;
EOF
grep -q '^pedido=' "$TMP/pedido.txt"  && ok "pedido lançado sob RLS" || { erro "salvar_pedido quebrou sob RLS"; sed 's/^/      /' "$TMP/pedido.txt"; }
grep -q '^autoria=1$' "$TMP/pedido.txt" && ok "pedido gravado com autoria" || erro "pedido sem usuario_id"

echo "▶ 004 — preço de mercado copiado do Mira"
rodar -f "$M/004_preco_mercado.up.sql"
psql -h "$SOCK" -U postgres -d f2 -qtA >/dev/null <<'EOF'
INSERT INTO preco_mercado (mira_id, origem, medida, marca, uf, preco)
VALUES (gen_random_uuid(), 'Concorrente', '185/60 R15', 'LowCost', 'MG', 220.00),
       (gen_random_uuid(), 'Meu',         '185/60R15',  'Gripmaster', 'MG', 485.00);
EOF
# O defeito que zerava a comparação no Mira: '185/60R15' vs '185/60 R15'.
[ "$(q "SELECT count(DISTINCT medida_norm) FROM preco_mercado")" = "1" ] \
  && ok "medida com e sem espaço casa (medida_norm)" || erro "normalização de medida não casou"
[ "$(q "SELECT count(*) FROM preco_mercado WHERE origem='Concorrente'")" = "1" ] \
  && ok "preço de concorrente gravado" || erro "concorrente não gravou"
if psql -h "$SOCK" -U postgres -d f2 -qtAc \
     "INSERT INTO preco_mercado (origem, medida, preco) VALUES ('Terceiro','X',1);" >/dev/null 2>&1
then erro "origem aceita valor fora de Meu/Concorrente"
else ok "origem restrita a Meu/Concorrente"; fi
if psql -h "$SOCK" -U postgres -d f2 -qtAc "SET ROLE anon; SELECT count(*) FROM preco_mercado;" >/dev/null 2>&1
then erro "anônimo lê preco_mercado"
else ok "anônimo barrado em preco_mercado"; fi
rodar -f "$M/004_preco_mercado.down.sql"
[ "$(q "SELECT count(*) FROM information_schema.tables WHERE table_name='preco_mercado'")" = "0" ] \
  && ok "004 reverte" || erro "preco_mercado sobrou"

echo "▶ guarda de ordem na reversão"
if rodar -f "$M/001_papeis.down.sql" >/dev/null 2>&1
then erro "001.down rodou com as políticas ainda de pé"
else ok "001.down recusa rodar antes de 003.down"; fi

echo "▶ revertendo"
rodar -f "$M/003_rls.down.sql"
rodar -f "$M/002_carteira.down.sql"
rodar -f "$M/001_papeis.down.sql"

[ "$(q "SELECT string_agg(enumlabel,',' ORDER BY enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='perfil_acesso'")" = "ADMIN,VENDEDOR" ] \
  && ok "enum voltou para ADMIN,VENDEDOR" || erro "enum não voltou"
[ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='cliente' AND column_name='representante_id'")" = "0" ] \
  && ok "coluna representante_id removida" || erro "coluna sobrou"
[ "$(q "SELECT count(*) FROM pg_proc WHERE proname='eh_admin'")" = "0" ] \
  && ok "função eh_admin removida" || erro "função sobrou"
[ "$(q "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='dev_all'")" = "9" ] \
  && ok "dev_all restaurada nas 9 tabelas originais" || erro "dev_all não restaurada"
[ "$(q "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='perfil_usuario'")" = "0" ] \
  && ok "perfil_usuario voltou sem política (como estava)" || erro "perfil_usuario ganhou política que não existia"

echo "▶ reaplicando (o ciclo é repetível)"
rodar -f "$M/001_papeis.up.sql"
rodar -v email_representante="$EMAIL" -f "$M/002_carteira.up.sql"
rodar -f "$M/003_rls.up.sql"
ok "segundo ciclo aplicou"

echo
if [ "$falhou" = "0" ]; then echo "migrações OK"; else echo "MIGRAÇÕES REPROVADAS"; fi
exit "$falhou"
