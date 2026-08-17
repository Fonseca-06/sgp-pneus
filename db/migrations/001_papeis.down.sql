-- F2 · 001 · REVERSÃO
--
-- ⚠️ Destrói `cliente.representante_id`. Se houver mais de uma carteira quando
-- você reverter, a atribuição individual NÃO volta sozinha. Dump antes:
--   COPY (SELECT id, representante_id FROM cliente) TO '/tmp/carteira.csv' CSV;
--
-- Rode 003_rls.down.sql ANTES — as políticas referenciam a coluna.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname='public' AND qual ILIKE '%representante_id%') THEN
    RAISE EXCEPTION 'Ainda há política RLS usando representante_id. Rode 003_rls.down.sql primeiro.';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_cliente_representante;
ALTER TABLE cliente DROP COLUMN IF EXISTS representante_id;

CREATE TYPE perfil_acesso_antigo AS ENUM ('ADMIN', 'VENDEDOR');

ALTER TABLE perfil_usuario ALTER COLUMN perfil DROP DEFAULT;
ALTER TABLE perfil_usuario
  ALTER COLUMN perfil TYPE perfil_acesso_antigo
  USING (CASE perfil::text WHEN 'REPRESENTANTE' THEN 'VENDEDOR' ELSE 'ADMIN' END)::perfil_acesso_antigo;

DROP TYPE perfil_acesso;
ALTER TYPE perfil_acesso_antigo RENAME TO perfil_acesso;

ALTER TABLE perfil_usuario ALTER COLUMN perfil SET DEFAULT 'VENDEDOR'::perfil_acesso;

COMMIT;
