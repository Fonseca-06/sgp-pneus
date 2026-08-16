-- F2 · 002 · REVERSÃO
--
-- Volta às políticas `dev_all`.
--
-- 🔴 REVERTER ISTO REABRE O ACHADO A2: a base de 48.891 pessoas com CPF/CNPJ,
-- telefone, e-mail, endereço e limite de crédito volta a ser legível por
-- qualquer um com a URL. Só rode em `localhost`, nunca com o app publicado.

BEGIN;

DO $$
DECLARE
  p record;
  t text;
BEGIN
  FOR p IN
    SELECT tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('usuario','cliente','fornecedor','perfil_importacao',
                         'produto','historico_preco','pedido','pedido_item',
                         'pedido_movimento','importacao')
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, p.tablename);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['usuario','cliente','fornecedor','perfil_importacao',
                           'produto','historico_preco','pedido','pedido_item',
                           'pedido_movimento','importacao']
  LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY dev_all ON public.%I FOR ALL USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.eh_admin();

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon;

COMMIT;
