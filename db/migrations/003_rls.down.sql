-- F2 · 003 · REVERSÃO
--
-- 🔴 REVERTER ISTO REABRE O ACHADO A2: a base de 48.891 pessoas com CPF/CNPJ,
-- telefone, e-mail, endereço e limite de crédito volta a ser legível por
-- qualquer um com a URL. Só rode em `localhost`, nunca com o app publicado.
--
-- Restaura o estado exato de antes: `dev_all` em 9 tabelas para o role
-- `public`, e NENHUMA política em perfil_usuario (que continua com RLS ligada
-- e portanto inacessível — era assim que estava).

BEGIN;

DO $$
DECLARE p record; t text;
BEGIN
  FOR p IN SELECT tablename, policyname FROM pg_policies WHERE schemaname='public'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, p.tablename);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['perfil_usuario','cliente','fornecedor','perfil_importacao',
                           'produto','historico_preco','pedido','pedido_item',
                           'pedido_movimento','importacao']
  LOOP
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
  END LOOP;

  -- perfil_usuario fica de fora de propósito: não tinha política.
  FOREACH t IN ARRAY ARRAY['cliente','fornecedor','perfil_importacao','produto',
                           'historico_preco','pedido','pedido_item',
                           'pedido_movimento','importacao']
  LOOP
    EXECUTE format('CREATE POLICY dev_all ON public.%I FOR ALL USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- salvar_pedido volta a não registrar autoria.
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
    INSERT INTO pedido (cliente_id, desconto_valor, total, total_liquido,
                        forma_pagto, observacao, validade_em)
    VALUES ((p_pedido->>'cliente_id')::BIGINT, v_desc, v_total, v_total - v_desc,
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

DROP FUNCTION IF EXISTS public.eh_admin();

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
GRANT ALL ON ALL TABLES    IN SCHEMA public TO anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon;

COMMIT;
