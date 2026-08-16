#!/usr/bin/env bash
# Testa as migrações da F2 contra um PostgreSQL descartável.
#
# Não toca no Supabase. Sobe um cluster local, reconstrói o schema a partir
# de db/baseline.sql, aplica 001+002, verifica que a RLS isola a
# carteira, reverte tudo e confere que o banco voltou ao estado anterior.
#
#   ./db/testar-migracoes.sh
#
# Requer: postgresql-16 instalado (initdb/pg_ctl em /usr/lib/postgresql/16/bin).
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

q() { psql -h "$SOCK" -U postgres -d f2 -tAc "$1"; }
rodar() { psql -h "$SOCK" -U postgres -d f2 -v ON_ERROR_STOP=1 -q "$@"; }

psql -h "$SOCK" -U postgres -qc "CREATE DATABASE f2;" >/dev/null
rodar -f "$RAIZ/db/baseline.sql"

echo "▶ aplicando 001 e 002"
rodar -v email_representante="$EMAIL" -f "$RAIZ/db/migrations/001_papeis.up.sql"
rodar -f "$RAIZ/db/migrations/002_rls.up.sql"

[ "$(q "SELECT count(*) FROM cliente WHERE representante_id IS NULL")" = "0" ] \
  && ok "todo cliente tem representante" || erro "sobrou cliente sem dono"

echo "▶ a RLS isola a carteira?"
psql -h "$SOCK" -U postgres -d f2 -qtA <<'EOF' > "$TMP/visao.txt"
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
grep -q '^fernanda=500$'  "$TMP/visao.txt" && ok "representante vê a carteira dela (500)"    || erro "representante não vê a própria carteira"
grep -q '^outra=0$'       "$TMP/visao.txt" && ok "outra representante vê 0"                  || erro "vazamento entre carteiras"
grep -q '^invadidos=0$'   "$TMP/visao.txt" && ok "não dá para alterar cliente de outra"      || erro "escrita cruzada permitida"
grep -q '^admin=500$'     "$TMP/visao.txt" && ok "admin vê tudo (500)"                       || erro "admin perdeu acesso"

# O achado A2: sem login, ninguém lê a base.
if psql -h "$SOCK" -U postgres -d f2 -qtAc "SET ROLE anon; SELECT count(*) FROM cliente;" >/dev/null 2>&1
then erro "ANÔNIMO AINDA LÊ A BASE — achado A2 aberto"
else ok "anônimo barrado (achado A2 fechado)"; fi

echo "▶ guarda de ordem na reversão"
if rodar -f "$RAIZ/db/migrations/001_papeis.down.sql" >/dev/null 2>&1
then erro "001.down rodou com as políticas ainda de pé"
else ok "001.down recusa rodar antes de 002.down"; fi

echo "▶ revertendo"
rodar -f "$RAIZ/db/migrations/002_rls.down.sql"
rodar -f "$RAIZ/db/migrations/001_papeis.down.sql"

[ "$(q "SELECT string_agg(enumlabel,',' ORDER BY enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='perfil_usuario'")" = "ADMIN,VENDEDOR" ] \
  && ok "enum voltou para ADMIN,VENDEDOR" || erro "enum não voltou"
[ "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='cliente' AND column_name='representante_id'")" = "0" ] \
  && ok "coluna representante_id removida" || erro "coluna sobrou"
[ "$(q "SELECT count(*) FROM pg_proc WHERE proname='eh_admin'")" = "0" ] \
  && ok "função eh_admin removida" || erro "função sobrou"
[ "$(q "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND policyname='dev_all'")" = "10" ] \
  && ok "políticas dev_all restauradas nas 10 tabelas" || erro "dev_all não restaurada"

echo "▶ reaplicando (o ciclo é repetível)"
rodar -v email_representante="$EMAIL" -f "$RAIZ/db/migrations/001_papeis.up.sql"
rodar -f "$RAIZ/db/migrations/002_rls.up.sql"
ok "segundo ciclo aplicou"

echo
if [ "$falhou" = "0" ]; then echo "migrações OK"; else echo "MIGRAÇÕES REPROVADAS"; fi
exit "$falhou"
