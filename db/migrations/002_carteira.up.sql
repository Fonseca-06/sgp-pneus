-- F2 · 002 · Atribuição da carteira
--
-- Hoje existe uma única representante. A base inteira é dela.
--
-- PRÉ-REQUISITO: a usuária precisa existir em auth.users. O signup está
-- desativado de propósito, então ela é criada pelo painel do Supabase
-- (Authentication → Users → Add user). Esta migração NÃO cria credencial.
--
--   psql -v email_representante=alguem@dominio -f 002_carteira.up.sql
--
-- Sem aspas no valor: o :'...' abaixo já as coloca.
--
-- O e-mail é copiado para um parâmetro de sessão antes do bloco porque o psql
-- NÃO interpola :variavel dentro de string com dollar-quoting. Aplicando pelo
-- editor SQL do Supabase, troque a linha do SET pelo e-mail literal.

BEGIN;

SET migracao.email_representante = :'email_representante';

DO $$
DECLARE
  email_rep  text := current_setting('migracao.email_representante', true);
  id_rep     uuid;
  atribuidos bigint;
BEGIN
  IF email_rep IS NULL OR email_rep = '' THEN
    RAISE EXCEPTION 'Informe -v email_representante=alguem@dominio ao rodar.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='cliente'
                    AND column_name='representante_id') THEN
    RAISE EXCEPTION 'Rode 001_papeis.up.sql antes desta migração.';
  END IF;

  SELECT id INTO id_rep FROM auth.users WHERE lower(email) = lower(email_rep);

  IF id_rep IS NULL THEN
    RAISE EXCEPTION
      'Usuária % não existe em auth.users. Crie-a pelo painel do Supabase antes de migrar (signup desativado).',
      email_rep;
  END IF;

  -- perfil_usuario.nome é NOT NULL sem default: deriva do e-mail se for novo.
  INSERT INTO perfil_usuario (id, nome, perfil)
       VALUES (id_rep, initcap(split_part(email_rep, '@', 1)), 'REPRESENTANTE'::perfil_acesso)
  ON CONFLICT (id) DO UPDATE SET perfil = 'REPRESENTANTE'::perfil_acesso;

  UPDATE cliente SET representante_id = id_rep WHERE representante_id IS NULL;
  GET DIAGNOSTICS atribuidos = ROW_COUNT;
  RAISE NOTICE 'Clientes atribuídos a %: %', email_rep, atribuidos;

  IF EXISTS (SELECT 1 FROM cliente WHERE representante_id IS NULL) THEN
    RAISE EXCEPTION 'Sobrou cliente sem representante — a RLS os tornaria invisíveis.';
  END IF;
END $$;

-- A partir daqui todo cliente novo precisa de dono.
ALTER TABLE cliente ALTER COLUMN representante_id SET NOT NULL;

COMMIT;
