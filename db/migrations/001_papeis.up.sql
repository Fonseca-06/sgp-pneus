-- F2 · 001 · Papel de representante comercial (só schema, sem dado)
--
-- R1: o par admin/vendedor vira representante comercial.
-- VENDEDOR → REPRESENTANTE. ADMIN sobrevive: sem ele ninguém administra
-- fornecedor, importação e configuração.
--
-- Não depende de nenhum usuário existir. A atribuição da carteira é a 002.
-- Reverter com 001_papeis.down.sql.
--
-- Nomes conferidos contra o banco real em 17/08/2026: a tabela de usuários é
-- `perfil_usuario` e o ENUM é `perfil_acesso` — o inverso do que o documento
-- de arquitetura sugere.

BEGIN;

DO $$
DECLARE faltando text := '';
BEGIN
  IF to_regclass('public.cliente') IS NULL THEN faltando := faltando || ' tabela cliente;'; END IF;
  IF to_regclass('public.perfil_usuario') IS NULL THEN faltando := faltando || ' tabela perfil_usuario;'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
                  WHERE n.nspname='public' AND t.typname='perfil_acesso') THEN
    faltando := faltando || ' tipo perfil_acesso;';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='perfil_usuario'
                    AND column_name='perfil') THEN
    faltando := faltando || ' coluna perfil_usuario.perfil;';
  END IF;
  IF faltando <> '' THEN
    RAISE EXCEPTION 'Schema divergente do esperado, migração abortada. Faltando:%', faltando;
  END IF;
END $$;

-- ------------------------------------------- 1. o ENUM, de forma reversível
-- ALTER TYPE ... ADD VALUE não tem volta. Troca de tipo tem.
CREATE TYPE perfil_acesso_novo AS ENUM ('ADMIN', 'REPRESENTANTE');

ALTER TABLE perfil_usuario ALTER COLUMN perfil DROP DEFAULT;
ALTER TABLE perfil_usuario
  ALTER COLUMN perfil TYPE perfil_acesso_novo
  USING (CASE perfil::text WHEN 'VENDEDOR' THEN 'REPRESENTANTE' ELSE 'ADMIN' END)::perfil_acesso_novo;

DROP TYPE perfil_acesso;
ALTER TYPE perfil_acesso_novo RENAME TO perfil_acesso;

ALTER TABLE perfil_usuario ALTER COLUMN perfil SET DEFAULT 'REPRESENTANTE'::perfil_acesso;

-- ------------------------------------------ 2. carteira: o dono de cada cliente
-- Nulo por enquanto. A 002 preenche; só depois vira NOT NULL.
ALTER TABLE cliente
  ADD COLUMN IF NOT EXISTS representante_id uuid REFERENCES perfil_usuario(id);

CREATE INDEX IF NOT EXISTS idx_cliente_representante ON cliente (representante_id);

COMMIT;
