-- F2 · 001 · Papel de representante comercial
--
-- R1: substitui o par admin/vendedor por representante comercial.
-- ADMIN é preservado — sem ele ninguém administra fornecedor, importação e
-- configuração. VENDEDOR vira REPRESENTANTE. Decisão registrada no PLANO.md §6.
--
-- ⚠️ NÃO VERIFICADO CONTRA O BANCO. Escrito com o projeto Supabase
-- xlpxbqyfdwhmfuoexgwm inacessível (DNS não resolve). O bloco de pré-checagem
-- abaixo aborta se o schema real divergir do esperado — prefira o erro à
-- migração que roda torto.
--
-- Rodar dentro de uma transação. Reverter com 001_papeis.down.sql.

BEGIN;

-- ---------------------------------------------------------------- pré-checagem
DO $$
DECLARE
  faltando text := '';
BEGIN
  IF to_regclass('public.cliente') IS NULL THEN
    faltando := faltando || ' tabela cliente;';
  END IF;
  IF to_regclass('public.usuario') IS NULL THEN
    faltando := faltando || ' tabela usuario;';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'perfil_usuario') THEN
    faltando := faltando || ' tipo perfil_usuario;';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'usuario'
                    AND column_name = 'perfil') THEN
    faltando := faltando || ' coluna usuario.perfil;';
  END IF;
  -- O UPSERT abaixo depende de usuario.id ser a PK e espelhar auth.users.id.
  IF NOT EXISTS (SELECT 1 FROM information_schema.key_column_usage k
                   JOIN information_schema.table_constraints c
                     ON c.constraint_name = k.constraint_name
                  WHERE c.table_schema = 'public' AND c.table_name = 'usuario'
                    AND c.constraint_type = 'PRIMARY KEY'
                    AND k.column_name = 'id') THEN
    faltando := faltando || ' PK usuario.id;';
  END IF;

  IF faltando <> '' THEN
    RAISE EXCEPTION
      'Schema divergente do esperado, migração abortada. Faltando:%', faltando;
  END IF;
END $$;

-- ------------------------------------------------- 1. o ENUM, de forma reversível
-- ALTER TYPE ... ADD VALUE não tem volta. Troca de tipo tem.
CREATE TYPE perfil_usuario_novo AS ENUM ('ADMIN', 'REPRESENTANTE');

ALTER TABLE usuario
  ALTER COLUMN perfil DROP DEFAULT;

ALTER TABLE usuario
  ALTER COLUMN perfil TYPE perfil_usuario_novo
  USING (CASE perfil::text
           WHEN 'VENDEDOR' THEN 'REPRESENTANTE'
           ELSE 'ADMIN'
         END)::perfil_usuario_novo;

DROP TYPE perfil_usuario;
ALTER TYPE perfil_usuario_novo RENAME TO perfil_usuario;

ALTER TABLE usuario
  ALTER COLUMN perfil SET DEFAULT 'REPRESENTANTE'::perfil_usuario;

-- ------------------------------------------- 2. carteira: o dono de cada cliente
ALTER TABLE cliente
  ADD COLUMN IF NOT EXISTS representante_id uuid REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_cliente_representante
  ON cliente (representante_id);

-- --------------------------------------------------------- 3. atribuição inicial
-- Hoje existe uma única representante: Fernanda. A base inteira é dela.
--
-- O e-mail entra por variável de psql:
--   psql -v email_representante=fernanda@exemplo.com -f 001_papeis.up.sql
--
-- Sem aspas no valor: o :'...' abaixo já as coloca. Passar com aspas grava o
-- e-mail com aspas dentro e a busca em auth.users não acha ninguém.
--
-- Ela é copiada para um parâmetro de sessão antes do bloco porque o psql NÃO
-- interpola :variavel dentro de string com dollar-quoting — o DO abaixo nunca
-- enxergaria :'email_representante'. Aplicando pelo editor SQL do Supabase,
-- troque a linha do SET pelo e-mail literal.
SET migracao.email_representante = :'email_representante';

DO $$
DECLARE
  email_rep   text := current_setting('migracao.email_representante', true);
  id_rep      uuid;
  atribuidos  bigint;
BEGIN
  IF email_rep IS NULL OR email_rep = '' THEN
    RAISE EXCEPTION 'Informe -v email_representante=alguem@dominio ao rodar.';
  END IF;

  SELECT id INTO id_rep
    FROM auth.users
   WHERE lower(email) = lower(email_rep);

  IF id_rep IS NULL THEN
    RAISE EXCEPTION
      'Usuária % não existe em auth.users. Crie-a no painel do Supabase antes de migrar (signup está desativado).',
      email_rep;
  END IF;

  INSERT INTO usuario (id, perfil)
       VALUES (id_rep, 'REPRESENTANTE'::perfil_usuario)
  ON CONFLICT (id) DO UPDATE SET perfil = 'REPRESENTANTE'::perfil_usuario;

  UPDATE cliente
     SET representante_id = id_rep
   WHERE representante_id IS NULL;

  GET DIAGNOSTICS atribuidos = ROW_COUNT;
  RAISE NOTICE 'Clientes atribuídos a %: %', email_rep, atribuidos;

  IF EXISTS (SELECT 1 FROM cliente WHERE representante_id IS NULL) THEN
    RAISE EXCEPTION 'Sobrou cliente sem representante — a RLS os tornaria invisíveis.';
  END IF;
END $$;

-- A partir daqui todo cliente novo precisa de dono.
ALTER TABLE cliente
  ALTER COLUMN representante_id SET NOT NULL;

COMMIT;
