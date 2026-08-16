-- Reconstrução do estado "antes" do SGP, para testar as migrações da F2.
-- Baseado em SGP - Arquitetura e Modelo de Dados.md e nas colunas observadas
-- em app.js / importar_clientes.py. Não é o schema completo: só o suficiente
-- para exercitar 001 e 002.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;

-- ---- stubs do Supabase ----
CREATE SCHEMA auth;
CREATE TABLE auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL
);
CREATE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.sub', true)::uuid $$;

-- ---- schema do SGP (recorte) ----
CREATE TYPE perfil_usuario AS ENUM ('ADMIN', 'VENDEDOR');
CREATE TYPE situacao_pedido AS ENUM ('ORCAMENTO','CONFIRMADO','ENTREGUE','CANCELADO');

CREATE TABLE usuario (
  id     uuid PRIMARY KEY REFERENCES auth.users(id),
  nome   text,
  perfil perfil_usuario NOT NULL DEFAULT 'VENDEDOR'
);

CREATE TABLE cliente (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo          text NOT NULL,
  documento     text UNIQUE NOT NULL,
  nome          text NOT NULL,
  vendedor_nome text,
  limite_credito numeric,
  ativo         boolean NOT NULL DEFAULT true
);

CREATE TABLE fornecedor (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text);
CREATE TABLE perfil_importacao (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fornecedor_id uuid);
CREATE TABLE produto (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fornecedor_id uuid REFERENCES fornecedor(id),
  medida text, marca text, modelo text,
  custo numeric, preco_venda numeric, ativo boolean DEFAULT true
);
CREATE TABLE historico_preco (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), produto_id uuid REFERENCES produto(id));
CREATE TABLE importacao (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), fornecedor_id uuid);

CREATE TABLE pedido (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero serial,
  cliente_id uuid REFERENCES cliente(id),
  usuario_id uuid REFERENCES usuario(id),
  situacao situacao_pedido NOT NULL DEFAULT 'ORCAMENTO',
  total_liquido numeric
);
CREATE TABLE pedido_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id uuid REFERENCES pedido(id),
  produto_id uuid REFERENCES produto(id),
  quantidade int, preco_unit numeric, custo_unit numeric
);
CREATE TABLE pedido_movimento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id uuid REFERENCES pedido(id),
  de situacao_pedido, para situacao_pedido, motivo text
);

-- ---- estado provisório que a F2 vem substituir ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['usuario','cliente','fornecedor','perfil_importacao',
                           'produto','historico_preco','pedido','pedido_item',
                           'pedido_movimento','importacao']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY dev_all ON public.%I FOR ALL USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT ALL ON public.%I TO anon, authenticated', t);
  END LOOP;
END $$;

-- ---- dados: a Fernanda, um admin, uma segunda representante e a carteira ----
-- `outra` existe só para provar que uma representante não enxerga a carteira
-- da outra. No banco real ela não existe — hoje a Fernanda é a única.
INSERT INTO auth.users (email)
  VALUES ('fernanda@teste.local'), ('admin@teste.local'), ('outra@teste.local');

INSERT INTO usuario (id, nome, perfil)
  SELECT id, 'Uendel', 'ADMIN' FROM auth.users WHERE email = 'admin@teste.local';
INSERT INTO usuario (id, nome, perfil)
  SELECT id, 'Outra', 'VENDEDOR' FROM auth.users WHERE email = 'outra@teste.local';

INSERT INTO cliente (tipo, documento, nome, vendedor_nome)
SELECT 'PJ', lpad(g::text, 14, '0'), 'Cliente ' || g, 'Fernanda'
  FROM generate_series(1, 500) g;
