-- Réplica do estado do banco ANTES da F2, para testar as migrações localmente.
--
-- Não é escrito de cabeça: espelha o schema real do projeto Supabase, lido em
-- 17/08/2026 via information_schema/pg_catalog. Se o banco mudar, regenerar.
-- Recorte: só o necessário para exercitar papéis, carteira e RLS.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;

-- ---------------------------------------------------------- stubs do Supabase
CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL
);
CREATE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.sub', true)::uuid $$;

-- No Supabase real, anon/authenticated enxergam o schema auth e podem chamar
-- auth.uid(). Sem isto o stub reprova a migração por um motivo que não existe
-- em produção. (Não damos SELECT em auth.users — lá também não têm.)
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;

-- ------------------------------------------------------------------- ENUMs
CREATE TYPE tipo_pessoa     AS ENUM ('PF','PJ');
CREATE TYPE perfil_acesso   AS ENUM ('ADMIN','VENDEDOR');
CREATE TYPE origem_preco    AS ENUM ('MANUAL','CSV','EMAIL','API');
CREATE TYPE situacao_pedido AS ENUM ('ORCAMENTO','CONFIRMADO','ENTREGUE','CANCELADO');

-- ------------------------------------------------------------------ tabelas
CREATE TABLE perfil_usuario (
  id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  nome      text NOT NULL,
  perfil    perfil_acesso NOT NULL DEFAULT 'VENDEDOR',
  ativo     boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cliente (
  id             bigserial PRIMARY KEY,
  tipo           tipo_pessoa NOT NULL,
  nome           text NOT NULL,
  documento      text NOT NULL,
  telefone       text, email text, cidade text, uf char(2),
  vendedor_nome  text,
  limite_credito numeric,
  ativo          boolean NOT NULL DEFAULT true,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_cliente_documento UNIQUE (documento)
);

CREATE TABLE fornecedor (
  id bigserial PRIMARY KEY, nome text NOT NULL, contato text,
  integracao origem_preco NOT NULL DEFAULT 'MANUAL', ativo boolean NOT NULL DEFAULT true
);

CREATE TABLE produto (
  id bigserial PRIMARY KEY,
  fornecedor_id bigint NOT NULL REFERENCES fornecedor(id),
  medida text NOT NULL, marca text NOT NULL, modelo text NOT NULL,
  custo numeric NOT NULL DEFAULT 0, preco_venda numeric NOT NULL DEFAULT 0,
  origem_preco origem_preco NOT NULL DEFAULT 'MANUAL',
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  ativo boolean NOT NULL DEFAULT true, codigo text
);

CREATE TABLE perfil_importacao (
  id bigserial PRIMARY KEY, fornecedor_id bigint NOT NULL REFERENCES fornecedor(id),
  separador char(1) NOT NULL DEFAULT ';', decimal_sep char(1) NOT NULL DEFAULT ',',
  mapeamento jsonb NOT NULL DEFAULT '{}', atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE importacao (
  id bigserial PRIMARY KEY, fornecedor_id bigint NOT NULL REFERENCES fornecedor(id),
  usuario_id uuid REFERENCES perfil_usuario(id),
  origem origem_preco NOT NULL DEFAULT 'CSV', arquivo_nome text,
  qtd_criados int NOT NULL DEFAULT 0, qtd_atualizados int NOT NULL DEFAULT 0,
  qtd_rejeitados int NOT NULL DEFAULT 0, relatorio jsonb,
  executado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE historico_preco (
  id bigserial PRIMARY KEY, produto_id bigint NOT NULL REFERENCES produto(id),
  custo_ant numeric, custo_novo numeric, venda_ant numeric, venda_novo numeric,
  origem origem_preco NOT NULL DEFAULT 'MANUAL',
  usuario_id uuid REFERENCES perfil_usuario(id),
  importacao_id bigint REFERENCES importacao(id),
  registrado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pedido (
  id bigserial PRIMARY KEY, numero bigserial UNIQUE,
  cliente_id bigint NOT NULL REFERENCES cliente(id),
  usuario_id uuid REFERENCES perfil_usuario(id),
  situacao situacao_pedido NOT NULL DEFAULT 'ORCAMENTO',
  desconto_valor numeric NOT NULL DEFAULT 0 CHECK (desconto_valor >= 0),
  total numeric NOT NULL DEFAULT 0, total_liquido numeric NOT NULL DEFAULT 0,
  forma_pagto text, observacao text, validade_em date,
  emitido_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pedido_item (
  id bigserial PRIMARY KEY, pedido_id bigint NOT NULL REFERENCES pedido(id),
  produto_id bigint NOT NULL REFERENCES produto(id), descricao text NOT NULL,
  quantidade int NOT NULL, preco_unit numeric NOT NULL, custo_unit numeric NOT NULL DEFAULT 0,
  desconto_valor numeric NOT NULL DEFAULT 0, subtotal numeric NOT NULL
);

CREATE TABLE pedido_movimento (
  id bigserial PRIMARY KEY, pedido_id bigint NOT NULL REFERENCES pedido(id),
  de situacao_pedido, para situacao_pedido NOT NULL, motivo text,
  usuario_id uuid REFERENCES perfil_usuario(id),
  registrado_em timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------- RPC que a F2 precisa corrigir (recorte real)
-- Reproduz o defeito: nunca preenche pedido.usuario_id. Sem o patch da 003, a
-- RLS rejeitaria todo pedido novo.
CREATE FUNCTION salvar_pedido(p_pedido jsonb, p_itens jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE v_id bigint := (p_pedido->>'id')::bigint; v_numero bigint;
BEGIN
  IF p_itens IS NULL OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'Pedido sem itens';
  END IF;
  INSERT INTO pedido (cliente_id, total, total_liquido)
  VALUES ((p_pedido->>'cliente_id')::bigint, 0, 0)
  RETURNING id, numero INTO v_id, v_numero;
  INSERT INTO pedido_movimento (pedido_id, de, para) VALUES (v_id, NULL, 'ORCAMENTO');
  RETURN jsonb_build_object('id', v_id, 'numero', v_numero);
END $fn$;

-- ------------------------------- estado provisório que a F2 vem substituir
-- Espelha o real: `dev_all` em 9 tabelas para o role `public`.
-- `perfil_usuario` tem RLS ligada e NENHUMA política — logo, ninguém a lê.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cliente','fornecedor','perfil_importacao','produto',
                           'historico_preco','pedido','pedido_item',
                           'pedido_movimento','importacao']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY dev_all ON public.%I FOR ALL USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT ALL ON public.%I TO anon, authenticated', t);
  END LOOP;
  EXECUTE 'ALTER TABLE public.perfil_usuario ENABLE ROW LEVEL SECURITY';
  EXECUTE 'GRANT ALL ON public.perfil_usuario TO anon, authenticated';
END $$;

-- O Supabase concede as sequences por padrão; sem isto o INSERT falha no stub
-- por um motivo que não existe em produção.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

-- ---- dados de teste: a representante, um admin, uma segunda e a carteira ----
-- `outra` só existe para provar que uma não enxerga a carteira da outra.
INSERT INTO auth.users (email)
  VALUES ('fernanda@teste.local'), ('admin@teste.local'), ('outra@teste.local');

INSERT INTO perfil_usuario (id, nome, perfil)
  SELECT id, 'Fernanda', 'VENDEDOR' FROM auth.users WHERE email='fernanda@teste.local';
INSERT INTO perfil_usuario (id, nome, perfil)
  SELECT id, 'Uendel', 'ADMIN' FROM auth.users WHERE email='admin@teste.local';
INSERT INTO perfil_usuario (id, nome, perfil)
  SELECT id, 'Outra', 'VENDEDOR' FROM auth.users WHERE email='outra@teste.local';

INSERT INTO fornecedor (nome) VALUES ('Estoque MG');
INSERT INTO produto (fornecedor_id, medida, marca, modelo, custo, preco_venda)
  SELECT 1, '185/60R15', 'Gripmaster', 'M'||g, 100, 200 FROM generate_series(1,10) g;

INSERT INTO cliente (tipo, documento, nome, vendedor_nome)
SELECT 'PJ', lpad(g::text, 14, '0'), 'Cliente ' || g, 'Fernanda'
  FROM generate_series(1, 500) g;
