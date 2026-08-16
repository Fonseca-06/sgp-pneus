-- F2 · 001 · REVERSÃO
--
-- Desfaz 001_papeis.up.sql: volta o ENUM para ('ADMIN','VENDEDOR') e remove a
-- coluna de carteira.
--
-- ⚠️ Perda de dado assumida e consciente: `cliente.representante_id` é
-- DESTRUÍDA. Se a base for maior que a carteira da Fernanda quando você
-- reverter, a atribuição individual não volta sozinha. Faça o dump antes:
--   COPY (SELECT id, representante_id FROM cliente) TO '/tmp/carteira.csv' CSV;
--
-- Rodar 002_rls.down.sql ANTES deste — as políticas referenciam a coluna.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public'
                AND qual ILIKE '%representante_id%') THEN
    RAISE EXCEPTION
      'Ainda há política RLS usando representante_id. Rode 002_rls.down.sql primeiro.';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_cliente_representante;

ALTER TABLE cliente
  DROP COLUMN IF EXISTS representante_id;

CREATE TYPE perfil_usuario_antigo AS ENUM ('ADMIN', 'VENDEDOR');

ALTER TABLE usuario
  ALTER COLUMN perfil DROP DEFAULT;

ALTER TABLE usuario
  ALTER COLUMN perfil TYPE perfil_usuario_antigo
  USING (CASE perfil::text
           WHEN 'REPRESENTANTE' THEN 'VENDEDOR'
           ELSE 'ADMIN'
         END)::perfil_usuario_antigo;

DROP TYPE perfil_usuario;
ALTER TYPE perfil_usuario_antigo RENAME TO perfil_usuario;

ALTER TABLE usuario
  ALTER COLUMN perfil SET DEFAULT 'VENDEDOR'::perfil_usuario;

COMMIT;
