"""Importa a LISTA DE PREÇO MG pro Supabase via RPC importar_precos (atômica).

- Fornecedor: "Estoque MG" (estoque da filial própria) — criado se não existir
- Preço da lista = preço de venda; custo fica 0 até ser definido
- Itens com preço 0 são pulados (sem preço não há venda)
- Marca extraída do fim da descrição (após o último " - ")
- Modelo = descrição sem prefixo KIT/PNEU, sem a medida e sem a marca

Uso:  python3 importar_pneus.py
"""
import json
import re
import urllib.request

import openpyxl

SUPABASE_URL = 'https://xlpxbqyfdwhmfuoexgwm.supabase.co'
SUPABASE_KEY = 'sb_publishable_TZfPp_39dCMikhQMFtGfSw_7fQThQ9t'
ARQUIVO = ('/mnt/c/Users/windows/Documents/02 - Trabalho/Clientes/Uendel/'
           'documentos/SGP/LISTA DE P´RECO MG 13 07 26.xlsx')
FORNECEDOR = 'Estoque MG'


def canon_medida(m):
    """Padrão carro vira '175/70 R13'; demais formatos ficam como estão, maiúsculos."""
    norm = re.sub(r'\s+', '', str(m or '').upper())
    if re.match(r'^\d{2,3}(\.\d+)?/\d{2,3}(\.\d+)?R\d{1,2}(\.\d)?(C|LT)?$', norm):
        return re.sub(r'R(\d)', r' R\1', norm)
    return norm


def medida_valida(canonica):
    padroes = [
        r'^\d{2,3}(\.\d+)?/\d{2,3}(\.\d+)? R\d{1,2}(\.\d)?(C|LT)?$',   # 175/70 R13
        r'^\d+(\.\d+)?R\d+(\.\d+)?(LT|C)?$',                           # 7.50R16LT, 185R14C
        r'^\d+(\.\d+)?-\d+(\.\d+)?$',                                  # 10.00-20, 10-16.5
        r'^\d+(\.\d+)?X\d+(\.\d+)?(-\d+(\.\d+)?)?(R\d+(\.\d+)?)?$',    # 28X9-15, 31X10.50R15
        r'^\d+(\.\d+)?/\d+(\.\d+)?$',                                  # 12.00/24
        r'^\d+(\.\d+)?/\d+(\.\d+)?(-|R)\d+(\.\d+)?(C|LT)?$',           # 12.5/80-18, 400/60-15.5
        r'^\d+(\.\d+)?L-\d+(\.\d+)?$',                                 # 11L-15 (agrícola)
    ]
    return any(re.match(p, canonica) for p in padroes)


MARCAS_VISTAS = set()


def achar_medida(medida_col, desc):
    """Tenta a coluna medida; se irreconhecível, procura na descrição."""
    bruto = re.sub(r'^PNEUS?\s+', '', str(medida_col or '').strip(), flags=re.I)
    candidatos = [bruto.split()[0]] if bruto else []
    candidatos += re.sub(r'^(KIT\s+)?PNEUS?\s+', '', desc, flags=re.I).split()[:3]
    for c in candidatos:
        m = canon_medida(c)
        if medida_valida(m):
            return m
        m = canon_medida(c.rstrip('.'))
        if medida_valida(m):
            return m
    return None


def achar_marca(desc):
    """Marca vem depois do último hífen (com ou sem espaços); fallback: último token já visto como marca."""
    m = re.search(r'[-–]\s*([A-Za-zÀ-ü][A-Za-zÀ-ü .&/]*?)\s*$', desc)
    if m and not any(ch.isdigit() for ch in m.group(1)):
        corpo = desc[:m.start()].strip()
        return m.group(1).strip().title(), corpo
    ultimo = desc.split()[-1] if desc.split() else ''
    if ultimo.isalpha() and ultimo.title() in MARCAS_VISTAS:
        return ultimo.title(), desc[:desc.rfind(ultimo)].strip()
    return None, desc


def extrair_item(codigo, desc, preco, medida_col):
    desc = str(desc or '').replace('\xa0', ' ').strip()
    medida = achar_medida(medida_col, desc)
    if medida is None:
        return None, f'Medida irreconhecível: "{medida_col}"'
    if not preco or float(preco) <= 0:
        return None, 'Sem preço na lista'

    marca, corpo = achar_marca(desc)
    if not marca:
        return None, f'Marca não identificada na descrição: "{desc}"'
    MARCAS_VISTAS.add(marca)

    corpo = re.sub(r'^(KIT\s+)?PNEUS?\s+', '', corpo, flags=re.I).strip()
    tokens = corpo.split()
    while tokens and (re.match(r'^[\dRXZ/.\-,]+$', tokens[0], re.I) or tokens[0].upper() in ('LT', 'C')):
        tokens.pop(0)

    indice_carga, indice_veloc = '', ''
    resto = []
    for t in tokens:
        m = re.match(r'^(\d{2,3}(?:/\d{2,3})?)([A-Z])$', t)
        if m and not indice_carga:
            indice_carga, indice_veloc = m.group(1), m.group(2)
        else:
            resto.append(t)
    modelo = ' '.join(resto).strip() or codigo.strip()

    item = {'codigo': codigo.strip(), 'medida': medida, 'marca': marca, 'modelo': modelo,
            'custo': '0.00', 'preco_venda': f'{float(preco):.2f}'}
    if indice_carga:
        item['indice_carga'] = indice_carga
        item['indice_veloc'] = indice_veloc
    return item, None


def api(caminho, payload=None, metodo='POST', extra_headers=None):
    headers = {'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}',
               'Content-Type': 'application/json'}
    headers.update(extra_headers or {})
    req = urllib.request.Request(f'{SUPABASE_URL}{caminho}',
                                 data=json.dumps(payload).encode() if payload is not None else None,
                                 headers=headers, method=metodo)
    with urllib.request.urlopen(req) as resp:
        corpo = resp.read().decode()
        return json.loads(corpo) if corpo else None


def main():
    fs = api(f'/rest/v1/fornecedor?nome=eq.{urllib.parse.quote(FORNECEDOR)}&select=id', metodo='GET')
    if fs:
        fornecedor_id = fs[0]['id']
    else:
        novo = api('/rest/v1/fornecedor', {'nome': FORNECEDOR, 'integracao': 'CSV'},
                   extra_headers={'Prefer': 'return=representation'})
        fornecedor_id = novo[0]['id']
    print(f'Fornecedor "{FORNECEDOR}" id={fornecedor_id}')

    wb = openpyxl.load_workbook(ARQUIVO, read_only=True, data_only=True)
    ws = wb.active
    linhas = ws.iter_rows(values_only=True)
    next(linhas)  # título "Gerar XML"
    next(linhas)  # cabeçalho

    itens_por_chave, rejeitadas = {}, []
    for n, r in enumerate(linhas, start=3):
        codigo, desc, preco, medida_col = r[0], r[1], r[7], r[9]
        if not desc:
            continue
        item, motivo = extrair_item(str(codigo or ''), desc, preco, medida_col)
        if item is None:
            rejeitadas.append({'linha': n, 'motivo': motivo})
            continue
        chave = f"{item['medida']}|{item['marca'].upper()}|{item['modelo'].upper()}"
        if chave in itens_por_chave:
            rejeitadas.append({'linha': n, 'motivo': 'Duplicada no arquivo (prevaleceu a última)'})
        itens_por_chave[chave] = item
    itens = list(itens_por_chave.values())
    print(f'{len(itens)} itens válidos, {len(rejeitadas)} rejeitados')

    resultado = api('/rest/v1/rpc/importar_precos', {
        'p_fornecedor_id': fornecedor_id,
        'p_arquivo_nome': 'LISTA DE PRECO MG 13 07 26.xlsx',
        'p_itens': itens,
        'p_qtd_rejeitados': len(rejeitadas),
        'p_relatorio': rejeitadas or None,
    })
    print('Resultado:', resultado)
    if rejeitadas:
        print('\nPrimeiros motivos de rejeição:')
        for rj in rejeitadas[:15]:
            print(f"  linha {rj['linha']}: {rj['motivo']}")


if __name__ == '__main__':
    main()
