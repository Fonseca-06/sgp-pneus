-- F6 · 004 · REVERSÃO
--
-- Seguro: `preco_mercado` é cópia. Os dados originais continuam no Mira e a
-- carga pode ser refeita com importar_precos_mira.py.

BEGIN;

DROP TABLE IF EXISTS preco_mercado;

COMMIT;
