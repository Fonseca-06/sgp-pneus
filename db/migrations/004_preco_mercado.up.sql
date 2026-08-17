-- F6 · 004 · Preço praticado por outras empresas
--
-- R2: base de consulta com preços de outras empresas, para comparar entre
-- marcas. Decisão do João Pedro em 17/08/2026: **copiar os preços para dentro
-- do app**, em vez de consultar o Mira ao vivo.
--
-- Esta tabela é CÓPIA, não fonte da verdade (regra 3 do briefing): quem manda
-- é o Mira (projeto kygpjnsqzhfcndqyuibw, tabela `precos`). `mira_id` guarda a
-- origem de cada linha, o que torna a recarga idempotente e permite auditar de
-- onde veio cada número.
--
-- ⚠️ PENDÊNCIA JURÍDICA EM ABERTO (pergunta 5 do PLANO.md): a procedência dos
-- preços de concorrente é NF fotografada, banner e cotação recebidos por
-- WhatsApp, e nenhum documento do projeto trata de autorização de uso. A
-- estrutura fica pronta; publicar o comparativo é decisão de negócio.

BEGIN;

CREATE TABLE IF NOT EXISTS preco_mercado (
  id          bigserial PRIMARY KEY,
  mira_id     uuid UNIQUE,                  -- id da linha original no Mira
  origem      text NOT NULL CHECK (origem IN ('Meu', 'Concorrente')),
  medida      text NOT NULL,
  -- Mesma solução do Mira: a comparação falhava por um espaço
  -- ('185/60R15' vs '185/60 R15'). Coluna gerada + índice resolvem na origem.
  medida_norm text GENERATED ALWAYS AS (upper(regexp_replace(medida, '\s+', '', 'g'))) STORED,
  marca       text,
  fornecedor  text,
  uf          char(2),
  preco       numeric(12,2) NOT NULL CHECK (preco >= 0),
  fonte       text,
  data        date,
  obs         text,
  importado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_preco_mercado_norm_uf ON preco_mercado (medida_norm, uf);
CREATE INDEX IF NOT EXISTS idx_preco_mercado_marca   ON preco_mercado (marca);

COMMENT ON TABLE preco_mercado IS
  'Cópia somente leitura dos preços do Mira. Fonte da verdade: projeto Mira, tabela precos.';

-- --------------------------------------------------------------------- RLS
-- Preço de mercado não é dado pessoal, mas também não é público: fica atrás
-- de sessão, como o resto. Escrita só pelo administrador (a carga roda com
-- service_role, que ignora RLS).
ALTER TABLE preco_mercado ENABLE ROW LEVEL SECURITY;
ALTER TABLE preco_mercado FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='eh_admin') THEN
    EXECUTE 'CREATE POLICY preco_mercado_le ON preco_mercado
               FOR SELECT TO authenticated USING (true)';
    EXECUTE 'CREATE POLICY preco_mercado_admin_escreve ON preco_mercado
               FOR ALL TO authenticated
               USING (public.eh_admin()) WITH CHECK (public.eh_admin())';
  ELSE
    RAISE EXCEPTION 'Rode 003_rls.up.sql antes: esta tabela depende de eh_admin().';
  END IF;
END $$;

REVOKE ALL ON preco_mercado FROM anon;
GRANT SELECT ON preco_mercado TO authenticated;

COMMIT;
