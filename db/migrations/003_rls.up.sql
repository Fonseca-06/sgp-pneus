-- F2 · 003 · Políticas RLS reais
--
-- Substitui as `dev_all` (que liberam tudo para o role `public`, anônimo
-- incluído) pelas regras do PLANO.md §6 resposta 3: o representante enxerga
-- só a carteira dele.
--
-- Fecha o achado A2: hoje qualquer pessoa com a URL lê os 48.891 clientes
-- completos — nome, CPF/CNPJ, telefone, e-mail, endereço, limite de crédito.
--
-- ⚠️ Depende de 001 e 002 aplicadas.
-- ⚠️ QUEBRA importar_clientes.py e importar_pneus.py enquanto usarem a chave
--    publishable. Migre-os para SUPABASE_SERVICE_KEY antes — ver README.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='cliente'
                    AND column_name='representante_id') THEN
    RAISE EXCEPTION 'Rode 001_papeis.up.sql antes desta migração.';
  END IF;
  IF EXISTS (SELECT 1 FROM cliente WHERE representante_id IS NULL) THEN
    RAISE EXCEPTION 'Há cliente sem representante — rode 002_carteira.up.sql antes, ou eles ficam invisíveis.';
  END IF;
END $$;

-- --------------------------------------------------------------------- helper
-- SECURITY DEFINER para ler perfil_usuario sem cair na RLS da própria tabela
-- (senão a política que chama a função dependeria da política — recursão).
CREATE OR REPLACE FUNCTION public.eh_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM perfil_usuario
     WHERE id = auth.uid() AND ativo AND perfil = 'ADMIN'::perfil_acesso
  );
$$;

REVOKE EXECUTE ON FUNCTION public.eh_admin() FROM public;
GRANT  EXECUTE ON FUNCTION public.eh_admin() TO authenticated;

-- ------------------------------------------- apaga as políticas provisórias
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT tablename, policyname FROM pg_policies WHERE schemaname='public'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END $$;

-- RLS ligada e sem escape, inclusive para o dono da tabela.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['perfil_usuario','cliente','fornecedor','perfil_importacao',
                           'produto','historico_preco','pedido','pedido_item',
                           'pedido_movimento','importacao']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ----------------------------------------------------------- perfil_usuario
CREATE POLICY perfil_le_o_proprio ON perfil_usuario
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.eh_admin());

CREATE POLICY perfil_admin_escreve ON perfil_usuario
  FOR ALL TO authenticated
  USING (public.eh_admin()) WITH CHECK (public.eh_admin());

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
-- deles para lançar pedido. Escrita é do administrador (RN: vendedor só consulta).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['fornecedor','produto','historico_preco',
                           'perfil_importacao','importacao']
  LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
                   t || '_le', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated '
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
  USING (EXISTS (SELECT 1 FROM pedido p WHERE p.id = pedido_item.pedido_id
                   AND (p.usuario_id = auth.uid() OR public.eh_admin())))
  WITH CHECK (EXISTS (SELECT 1 FROM pedido p WHERE p.id = pedido_item.pedido_id
                        AND (p.usuario_id = auth.uid() OR public.eh_admin())));

CREATE POLICY pedido_movimento_segue_pedido ON pedido_movimento
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM pedido p WHERE p.id = pedido_movimento.pedido_id
                   AND (p.usuario_id = auth.uid() OR public.eh_admin())))
  WITH CHECK (EXISTS (SELECT 1 FROM pedido p WHERE p.id = pedido_movimento.pedido_id
                        AND (p.usuario_id = auth.uid() OR public.eh_admin())));

-- ------------------------------------------------ salvar_pedido: autoria
-- A RPC nunca preencheu pedido.usuario_id. Com a política acima, todo pedido
-- novo passaria a ser REJEITADO. Não é ajuste cosmético: sem isto a F2 quebra
-- o lançamento de venda, que é o fluxo principal do representante.
--
-- Único trecho alterado em relação ao corpo atual: a coluna usuario_id no
-- INSERT e o auth.uid() correspondente.
CREATE OR REPLACE FUNCTION public.salvar_pedido(p_pedido jsonb, p_itens jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $function$
DECLARE
  v_id       BIGINT := (p_pedido->>'id')::BIGINT;
  v_situacao situacao_pedido;
  v_total    NUMERIC(12,2) := 0;
  v_desc     NUMERIC(12,2) := COALESCE((p_pedido->>'desconto_valor')::NUMERIC, 0);
  v_numero   BIGINT;
  v_sub      NUMERIC(12,2);
  item       JSONB;
BEGIN
  IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'Pedido sem itens';
  END IF;
  IF v_desc < 0 THEN RAISE EXCEPTION 'Desconto não pode ser negativo'; END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    IF (item->>'quantidade')::INT <= 0 THEN RAISE EXCEPTION 'Quantidade deve ser maior que zero'; END IF;
    v_sub := ((item->>'preco_unit')::NUMERIC * (item->>'quantidade')::INT)
             - COALESCE((item->>'desconto_valor')::NUMERIC, 0);
    IF v_sub < 0 THEN RAISE EXCEPTION 'Desconto do item maior que o valor do item'; END IF;
    v_total := v_total + v_sub;
  END LOOP;
  IF v_desc > v_total THEN RAISE EXCEPTION 'Desconto total maior que o valor do pedido'; END IF;

  IF v_id IS NULL THEN
    INSERT INTO pedido (cliente_id, usuario_id, desconto_valor, total, total_liquido,
                        forma_pagto, observacao, validade_em)
    VALUES ((p_pedido->>'cliente_id')::BIGINT, auth.uid(), v_desc, v_total, v_total - v_desc,
            NULLIF(p_pedido->>'forma_pagto', ''), NULLIF(p_pedido->>'observacao', ''),
            COALESCE((p_pedido->>'validade_em')::DATE, (now() + INTERVAL '7 days')::DATE))
    RETURNING id, numero INTO v_id, v_numero;
    INSERT INTO pedido_movimento (pedido_id, de, para) VALUES (v_id, NULL, 'ORCAMENTO');
  ELSE
    SELECT situacao INTO v_situacao FROM pedido WHERE id = v_id FOR UPDATE;
    IF v_situacao IS NULL THEN RAISE EXCEPTION 'Pedido não encontrado'; END IF;
    IF v_situacao <> 'ORCAMENTO' THEN
      RAISE EXCEPTION 'Somente orçamento admite alteração de itens e valores (RN05)';
    END IF;
    UPDATE pedido
       SET cliente_id = (p_pedido->>'cliente_id')::BIGINT,
           desconto_valor = v_desc, total = v_total, total_liquido = v_total - v_desc,
           forma_pagto = NULLIF(p_pedido->>'forma_pagto', ''),
           observacao = NULLIF(p_pedido->>'observacao', '')
     WHERE id = v_id RETURNING numero INTO v_numero;
    DELETE FROM pedido_item WHERE pedido_id = v_id;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    INSERT INTO pedido_item (pedido_id, produto_id, descricao, quantidade,
                             preco_unit, custo_unit, desconto_valor, subtotal)
    VALUES (v_id, (item->>'produto_id')::BIGINT, item->>'descricao',
            (item->>'quantidade')::INT, (item->>'preco_unit')::NUMERIC,
            COALESCE((item->>'custo_unit')::NUMERIC, 0),
            COALESCE((item->>'desconto_valor')::NUMERIC, 0),
            ((item->>'preco_unit')::NUMERIC * (item->>'quantidade')::INT)
              - COALESCE((item->>'desconto_valor')::NUMERIC, 0));
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'numero', v_numero);
END $function$;

-- ------------------------------------------------- anônimo não lê mais nada
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
-- E nem no que vier depois — sem isto, a próxima tabela criada nasce legível
-- pelo anônimo e o buraco A2 reabre em silêncio.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

COMMIT;

-- ============================================================================
-- NÃO RESOLVIDO POR ESTA MIGRAÇÃO — RN12
--
-- "Somente o administrador visualiza custo e margem" é regra de COLUNA, e RLS
-- é regra de LINHA. `produto.custo` e `pedido_item.custo_unit` continuam
-- legíveis pelo representante.
--
-- A solução é uma view sem as colunas de custo + REVOKE SELECT nas tabelas
-- base, o que muda toda a camada de leitura do app.js. É fatia própria.
-- Registrado em SUGESTOES.md.
-- ============================================================================
