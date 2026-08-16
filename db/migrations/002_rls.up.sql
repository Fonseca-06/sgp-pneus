-- F2 · 002 · Políticas RLS reais
--
-- Substitui as políticas `dev_all` (que liberam tudo para todos) pelas regras
-- do PLANO.md §6 resposta 3: o representante enxerga só a carteira dele.
--
-- Fecha o achado A2: hoje qualquer pessoa com a URL lê os 48.891 clientes
-- completos — nome, CPF/CNPJ, telefone, e-mail, endereço, limite de crédito.
--
-- ⚠️ NÃO VERIFICADO CONTRA O BANCO (projeto inacessível na escrita).
-- ⚠️ Depende de 001_papeis.up.sql já aplicado.
-- ⚠️ QUEBRA importar_clientes.py e importar_pneus.py: eles usam a chave
--    publishable e passam a ser barrados. Precisam migrar para service_role
--    em variável de ambiente — ver README e SUGESTOES.md.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'cliente'
                    AND column_name = 'representante_id') THEN
    RAISE EXCEPTION 'Rode 001_papeis.up.sql antes desta migração.';
  END IF;
END $$;

-- ------------------------------------------------------------------- helpers
-- SECURITY DEFINER para poder ler `usuario` sem cair na RLS da própria tabela.
-- STABLE permite ao planejador avaliar uma vez por query em vez de por linha.
CREATE OR REPLACE FUNCTION public.eh_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM usuario
     WHERE id = auth.uid()
       AND perfil = 'ADMIN'::perfil_usuario
  );
$$;

REVOKE EXECUTE ON FUNCTION public.eh_admin() FROM public;
GRANT  EXECUTE ON FUNCTION public.eh_admin() TO authenticated;

-- ------------------------------------------- apaga as políticas provisórias
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('usuario','cliente','fornecedor','perfil_importacao',
                         'produto','historico_preco','pedido','pedido_item',
                         'pedido_movimento','importacao')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I',
                   p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;

-- Garante RLS ligado e sem escape para o dono da tabela.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['usuario','cliente','fornecedor','perfil_importacao',
                           'produto','historico_preco','pedido','pedido_item',
                           'pedido_movimento','importacao']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------ usuario
CREATE POLICY usuario_le_o_proprio ON usuario
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.eh_admin());

CREATE POLICY usuario_admin_escreve ON usuario
  FOR ALL TO authenticated
  USING (public.eh_admin())
  WITH CHECK (public.eh_admin());

-- ------------------------------------------------------------------ cliente
-- O coração do achado A2.
CREATE POLICY cliente_carteira_le ON cliente
  FOR SELECT TO authenticated
  USING (representante_id = auth.uid() OR public.eh_admin());

CREATE POLICY cliente_carteira_insere ON cliente
  FOR INSERT TO authenticated
  WITH CHECK (representante_id = auth.uid() OR public.eh_admin());

CREATE POLICY cliente_carteira_altera ON cliente
  FOR UPDATE TO authenticated
  USING (representante_id = auth.uid() OR public.eh_admin())
  WITH CHECK (representante_id = auth.uid() OR public.eh_admin());

-- Sem DELETE: a regra do sistema é inativar, não excluir.

-- ---------------------------------------------- catálogo: leitura para todos
-- Produto, fornecedor e preço não são dado pessoal e o representante precisa
-- deles para lançar pedido. Escrita é do administrador.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fornecedor','produto','historico_preco',
                           'perfil_importacao','importacao']
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      t || '_le', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated '
      'USING (public.eh_admin()) WITH CHECK (public.eh_admin())',
      t || '_admin_escreve', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------------- pedido
CREATE POLICY pedido_proprio_le ON pedido
  FOR SELECT TO authenticated
  USING (usuario_id = auth.uid() OR public.eh_admin());

CREATE POLICY pedido_proprio_insere ON pedido
  FOR INSERT TO authenticated
  WITH CHECK (usuario_id = auth.uid() OR public.eh_admin());

CREATE POLICY pedido_proprio_altera ON pedido
  FOR UPDATE TO authenticated
  USING (usuario_id = auth.uid() OR public.eh_admin())
  WITH CHECK (usuario_id = auth.uid() OR public.eh_admin());

-- ------------------------------------------- itens e movimentos seguem o pai
CREATE POLICY pedido_item_segue_pedido ON pedido_item
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM pedido p
                  WHERE p.id = pedido_item.pedido_id
                    AND (p.usuario_id = auth.uid() OR public.eh_admin())))
  WITH CHECK (EXISTS (SELECT 1 FROM pedido p
                       WHERE p.id = pedido_item.pedido_id
                         AND (p.usuario_id = auth.uid() OR public.eh_admin())));

CREATE POLICY pedido_movimento_segue_pedido ON pedido_movimento
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM pedido p
                  WHERE p.id = pedido_movimento.pedido_id
                    AND (p.usuario_id = auth.uid() OR public.eh_admin())))
  WITH CHECK (EXISTS (SELECT 1 FROM pedido p
                       WHERE p.id = pedido_movimento.pedido_id
                         AND (p.usuario_id = auth.uid() OR public.eh_admin())));

-- ------------------------------------------------- anônimo não lê mais nada
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

-- E nem nas tabelas que vierem depois — sem isto, a próxima tabela criada
-- nasce legível pelo anônimo e o buraco A2 reabre em silêncio.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

COMMIT;

-- ============================================================================
-- NÃO RESOLVIDO POR ESTA MIGRAÇÃO — RN12
--
-- "Somente o administrador visualiza custo e margem" é regra de COLUNA, e RLS
-- é regra de LINHA. `produto.custo` e `pedido_item.custo_unit` continuam
-- legíveis pelo representante.
--
-- A solução correta é uma view sem as colunas de custo + REVOKE SELECT nas
-- tabelas base, o que muda toda a camada de leitura do app.js. É fatia
-- própria, não item de rodapé desta. Registrado em SUGESTOES.md.
-- ============================================================================
