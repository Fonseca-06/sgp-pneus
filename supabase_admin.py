"""Credencial e chamadas dos scripts de carga.

Por que existe: a F2 fecha a RLS. A chave publishable, que antes escrevia em
tudo porque as políticas eram `dev_all`, passa a ser barrada. Os scripts de
importação rodam fora do navegador e não têm sessão de usuário — precisam da
chave `service_role`, que ignora RLS.

A chave NUNCA fica no arquivo. Vem do ambiente:

    export SUPABASE_SERVICE_KEY='...'      # painel → Settings → API → service_role
    python3 importar_clientes.py

Regra 4 do projeto: essa chave dá acesso total ao banco. Não commitar, não
colar em chat, não deixar em histórico de shell (use um espaço antes do
`export`, ou um arquivo .env fora do repositório).
"""
import json
import os
import sys
import urllib.error
import urllib.request

SUPABASE_URL = os.environ.get(
    'SUPABASE_URL', 'https://xlpxbqyfdwhmfuoexgwm.supabase.co')

_AVISO = """
ERRO: falta a variável SUPABASE_SERVICE_KEY.

Depois da migração 003 a RLS está ativa e a chave pública não escreve mais.
Pegue a chave `service_role` em:
  Supabase → Settings → API → Project API keys → service_role

e rode:
   export SUPABASE_SERVICE_KEY='cole-aqui'     (o espaço no início evita o histórico)
  python3 %s
"""


def chave():
    """Devolve a service_role, ou explica e encerra."""
    k = os.environ.get('SUPABASE_SERVICE_KEY')
    if not k:
        sys.exit(_AVISO % os.path.basename(sys.argv[0]))
    return k


def api(caminho, payload=None, metodo='POST', extra_headers=None):
    """Chamada REST autenticada como service_role."""
    k = chave()
    headers = {'apikey': k, 'Authorization': f'Bearer {k}',
               'Content-Type': 'application/json'}
    headers.update(extra_headers or {})
    req = urllib.request.Request(
        f'{SUPABASE_URL}{caminho}',
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers, method=metodo)
    with urllib.request.urlopen(req) as resp:
        corpo = resp.read().decode()
        return json.loads(corpo) if corpo else None


def coluna_existe(tabela, coluna):
    """True se a tabela já tem a coluna — para os scripts funcionarem antes e
    depois da migração, sem duas versões do arquivo."""
    try:
        api(f'/rest/v1/{tabela}?select={coluna}&limit=1', metodo='GET')
        return True
    except urllib.error.HTTPError as e:
        if e.code in (400, 404):
            return False
        raise


def representante_id():
    """Dono dos clientes importados.

    `cliente.representante_id` é NOT NULL depois da 002, e o script não tem
    sessão de usuário para o `auth.uid()` preencher. Resolve assim:

    1. MIRA_REPRESENTANTE_ID no ambiente, se você quiser mandar explicitamente;
    2. senão, o único perfil REPRESENTANTE do banco.

    Com mais de um, para e pede o explícito — adivinhar de quem é a carteira de
    48 mil pessoas seria o tipo de chute que não se conserta depois.
    """
    explicito = os.environ.get('MIRA_REPRESENTANTE_ID')
    if explicito:
        return explicito

    reps = api('/rest/v1/perfil_usuario?select=id,nome&perfil=eq.REPRESENTANTE&ativo=is.true',
               metodo='GET') or []
    if len(reps) == 1:
        print(f"Carteira atribuída a: {reps[0].get('nome') or reps[0]['id']}")
        return reps[0]['id']
    if not reps:
        sys.exit('ERRO: nenhum REPRESENTANTE ativo no banco. Crie a usuária no '
                 'painel e rode db/migrations/002_carteira.up.sql.')
    nomes = ', '.join(r.get('nome') or r['id'] for r in reps)
    sys.exit(f'ERRO: há mais de um representante ({nomes}). Informe de quem é a '
             f'carteira:\n  export MIRA_REPRESENTANTE_ID=<uuid>')
