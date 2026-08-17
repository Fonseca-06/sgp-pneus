-- F2 · 002 · REVERSÃO
--
-- Solta a obrigatoriedade e esvazia a carteira. A coluna continua existindo —
-- quem a remove é 001_papeis.down.sql.
--
-- ⚠️ Dump antes, se houver mais de uma carteira:
--   COPY (SELECT id, representante_id FROM cliente) TO '/tmp/carteira.csv' CSV;

BEGIN;

ALTER TABLE cliente ALTER COLUMN representante_id DROP NOT NULL;
UPDATE cliente SET representante_id = NULL;

-- O perfil da representante não é apagado: ela continua sendo usuária.
-- Para rebaixá-la, rode 001_papeis.down.sql (REPRESENTANTE volta a VENDEDOR).

COMMIT;
