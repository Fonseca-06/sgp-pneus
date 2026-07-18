"""Importa a base de clientes (Base de dados Mira.xlsx, aba BASE_UNICA) pro Supabase.

Uso:  python3 importar_clientes.py
Idempotente: upsert por documento (on_conflict) — rodar de novo não duplica.
"""
import json
import re
import urllib.request

import openpyxl

SUPABASE_URL = 'https://xlpxbqyfdwhmfuoexgwm.supabase.co'
SUPABASE_KEY = 'sb_publishable_TZfPp_39dCMikhQMFtGfSw_7fQThQ9t'
ARQUIVO = ('/mnt/c/Users/windows/Documents/02 - Trabalho/Clientes/Uendel/'
           'documentos/SGP/Base de dados Mira.xlsx')
LOTE = 500


def limpa(v):
    s = str(v).strip() if v is not None else ''
    return s if s and s not in ('0', 'NÃO INFORMADO', 'None') else None


def so_digitos(v):
    return re.sub(r'\D', '', str(v or ''))


def data_iso(v):
    s = str(v or '')
    m = re.match(r'(\d{4}-\d{2}-\d{2})', s)
    return m.group(1) if m else None


def inteiro(v):
    try:
        n = int(float(str(v).replace(',', '.')))
        return n if n >= 0 else None
    except (ValueError, TypeError):
        return None


def decimal(v):
    try:
        n = round(float(str(v).replace(',', '.')), 2)
        return n if n > 0 else None
    except (ValueError, TypeError):
        return None


def montar_registro(r, idx):
    doc = so_digitos(r[idx['CPF/CNPJ']])
    if len(doc) not in (11, 14):
        return None
    cep = so_digitos(r[idx['CEP']]) or None
    if cep and len(cep) == 7:
        cep = '0' + cep
    return {
        'tipo': 'PF' if len(doc) == 11 else 'PJ',
        'nome': limpa(r[idx['Cliente']]) or '(sem nome)',
        'documento': doc,
        'telefone': limpa(r[idx['Telefone Fixo']]),
        'celular': limpa(r[idx['Telefone Celular']]),
        'email': limpa(r[idx['E-mail']]),
        'cep': cep,
        'logradouro': limpa(r[idx['Rua']]),
        'numero': limpa(r[idx['Número']]),
        'complemento': limpa(r[idx['Complemento']]),
        'bairro': limpa(r[idx['Bairro']]),
        'cidade': limpa(r[idx['Cidade']]),
        'uf': (limpa(r[idx['Estado']]) or '')[:2] or None,
        'segmento': limpa(r[idx['Segmento']]),
        'criado_em': data_iso(r[idx['Data Cadastro']]),
        'categoria': limpa(r[idx['Categoria']]),
        'qtd_veiculos': inteiro(r[idx['Qtd Veiculos']]),
        'limite_credito': decimal(r[idx['LIMITE VERUM']]),
        'qtd_compras': inteiro(r[idx['Qtd Compras Acumulado']]),
        'primeira_compra': data_iso(r[idx['Data Pri Comp']]),
        'ultima_compra': data_iso(r[idx['Ultimo Pedido']]),
    }


def enviar_lote(registros):
    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/cliente?on_conflict=documento',
        data=json.dumps(registros).encode(),
        headers={
            'apikey': SUPABASE_KEY,
            'Authorization': f'Bearer {SUPABASE_KEY}',
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        method='POST',
    )
    with urllib.request.urlopen(req) as resp:
        return resp.status


def main():
    print('Lendo planilha...')
    wb = openpyxl.load_workbook(ARQUIVO, read_only=True, data_only=True)
    ws = wb['BASE_UNICA']
    linhas = ws.iter_rows(values_only=True)
    headers = [str(h).strip() for h in next(linhas)]
    idx = {h: i for i, h in enumerate(headers)}

    registros, pulados = [], 0
    for r in linhas:
        reg = montar_registro(r, idx)
        if reg is None:
            pulados += 1
        else:
            registros.append(reg)
    print(f'{len(registros)} clientes válidos, {pulados} pulados (sem documento)')

    enviados = 0
    for i in range(0, len(registros), LOTE):
        lote = registros[i:i + LOTE]
        try:
            enviar_lote(lote)
        except urllib.error.HTTPError as e:
            print(f'\nERRO no lote {i // LOTE + 1}: {e.read().decode()[:500]}')
            raise
        enviados += len(lote)
        print(f'\r{enviados}/{len(registros)} enviados...', end='', flush=True)
    print('\nConcluído.')


if __name__ == '__main__':
    main()
