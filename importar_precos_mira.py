"""Copia os preços de mercado do Mira para dentro do Mira Sales.

Os dois sistemas são projetos Supabase separados. A decisão (17/08/2026) foi
copiar, não consultar ao vivo: o Mira segue sendo a fonte da verdade e esta
carga é uma cópia datada, rastreável linha a linha por `mira_id`.

Idempotente: upsert por `mira_id`. Rodar de novo atualiza, não duplica.

Uso:
   export SUPABASE_SERVICE_KEY='...'        # destino — Mira Sales
   export MIRA_URL='https://kygpjnsqzhfcndqyuibw.supabase.co'
   export MIRA_KEY='...'                    # origem — Mira
  python3 importar_precos_mira.py [--seco]

Sobre MIRA_KEY: a RLS do Mira exige usuário autenticado, então a chave anon
pública NÃO enxerga a tabela `precos` (devolve lista vazia, sem erro — foi o
que aconteceu na primeira tentativa). Use a `service_role` do projeto Mira.

Regra 3 do briefing: esta base é somente leitura. O script nunca escreve no
Mira — só faz GET lá e POST aqui.
"""
import json
import os
import sys
import urllib.error
import urllib.request

from supabase_admin import SUPABASE_URL, chave

MIRA_URL = os.environ.get('MIRA_URL', 'https://kygpjnsqzhfcndqyuibw.supabase.co')
PAGINA = 1000

CAMPOS = ('id', 'origem', 'medida', 'marca', 'fornecedor', 'uf',
          'preco', 'fonte', 'data', 'obs')


def ler_do_mira():
    """Lê `precos` do Mira, paginado. Somente GET."""
    k = os.environ.get('MIRA_KEY')
    if not k:
        sys.exit('ERRO: falta MIRA_KEY (service_role do projeto Mira).\n'
                 'A chave anon não serve: a RLS do Mira devolve lista vazia '
                 'para quem não está autenticado.')

    linhas, inicio = [], 0
    while True:
        req = urllib.request.Request(
            f"{MIRA_URL}/rest/v1/precos?select={','.join(CAMPOS)}&order=id",
            headers={'apikey': k, 'Authorization': f'Bearer {k}',
                     'Range-Unit': 'items',
                     'Range': f'{inicio}-{inicio + PAGINA - 1}'},
            method='GET')
        try:
            with urllib.request.urlopen(req) as resp:
                lote = json.loads(resp.read().decode() or '[]')
        except urllib.error.HTTPError as e:
            sys.exit(f'ERRO ao ler o Mira ({e.code}): {e.read().decode()[:300]}')
        if not lote:
            break
        linhas.extend(lote)
        if len(lote) < PAGINA:
            break
        inicio += PAGINA
    return linhas


def converter(linha):
    """Linha do Mira → linha de preco_mercado. Descarta o que não dá para usar."""
    if linha.get('origem') not in ('Meu', 'Concorrente'):
        return None
    if not linha.get('medida'):
        return None
    try:
        preco = round(float(linha.get('preco')), 2)
    except (TypeError, ValueError):
        return None
    if preco < 0:
        return None
    uf = (linha.get('uf') or '').strip().upper()[:2] or None
    return {
        'mira_id': linha['id'],
        'origem': linha['origem'],
        'medida': str(linha['medida']).strip(),
        'marca': (linha.get('marca') or '').strip() or None,
        'fornecedor': (linha.get('fornecedor') or '').strip() or None,
        'uf': uf,
        'preco': preco,
        'fonte': (linha.get('fonte') or '').strip() or None,
        'data': linha.get('data') or None,
        'obs': (linha.get('obs') or '').strip() or None,
    }


def enviar(registros):
    k = chave()
    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/preco_mercado?on_conflict=mira_id',
        data=json.dumps(registros).encode(),
        headers={'apikey': k, 'Authorization': f'Bearer {k}',
                 'Content-Type': 'application/json',
                 'Prefer': 'resolution=merge-duplicates,return=minimal'},
        method='POST')
    with urllib.request.urlopen(req) as resp:
        return resp.status


def main():
    seco = '--seco' in sys.argv

    print('Lendo o Mira (somente leitura)...')
    brutas = ler_do_mira()
    print(f'{len(brutas)} linhas na origem')

    registros, descartadas = [], 0
    for linha in brutas:
        conv = converter(linha)
        if conv is None:
            descartadas += 1
        else:
            registros.append(conv)

    concorrente = sum(1 for r in registros if r['origem'] == 'Concorrente')
    ufs = sorted({r['uf'] for r in registros if r['uf']})
    print(f'{len(registros)} aproveitadas ({concorrente} de concorrente), '
          f'{descartadas} descartadas')
    print(f'UFs cobertas: {", ".join(ufs) or "nenhuma"}')

    if not registros:
        sys.exit('Nada a importar. Se a origem tinha linhas, verifique a MIRA_KEY '
                 '— a RLS do Mira devolve vazio em vez de erro.')

    if seco:
        print('\n--seco: nada foi gravado. Amostra:')
        for r in registros[:3]:
            print('  ', {c: r[c] for c in ('origem', 'medida', 'marca', 'uf', 'preco')})
        return

    enviados = 0
    for i in range(0, len(registros), 500):
        lote = registros[i:i + 500]
        try:
            enviar(lote)
        except urllib.error.HTTPError as e:
            print(f'\nERRO no lote {i // 500 + 1}: {e.read().decode()[:500]}')
            raise
        enviados += len(lote)
        print(f'\r{enviados}/{len(registros)} gravados...', end='', flush=True)
    print('\nConcluído.')


if __name__ == '__main__':
    main()
