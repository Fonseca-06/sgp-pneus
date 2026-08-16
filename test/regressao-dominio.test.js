// Linha de base de regressão do SGP, capturada ANTES da refatoração para Mira Sales.
// Cada teste amarra uma regra de negócio documentada (RN/RF). Se uma fatia futura
// quebrar qualquer um destes comportamentos, o gate `npm test` reprova.
import { describe, it, expect, beforeAll } from 'vitest'
import { montarApp } from './harness.js'

let w
beforeAll(() => { w = montarApp().window })

describe('RN01 — normalização de medida', () => {
  it('padrão carro ganha espaço antes do R', () => {
    expect(w.medidaCanonica('175/70r13')).toBe('175/70 R13')
    expect(w.medidaCanonica('175/70 R 13')).toBe('175/70 R13')
    expect(w.medidaCanonica('175 / 70 R13')).toBe('175/70 R13')
  })

  it('caminhão, agrícola e OTR ficam sem espaço, em maiúsculo', () => {
    expect(w.medidaCanonica('10.00-20')).toBe('10.00-20')
    expect(w.medidaCanonica('11l-15')).toBe('11L-15')
    expect(w.medidaCanonica('28x9-15')).toBe('28X9-15')
  })

  it('normMedida remove todo espaço e sobe para maiúsculo', () => {
    expect(w.normMedida(' 185/60 r15 ')).toBe('185/60R15')
  })

  it('medidas fora dos padrões do mercado são rejeitadas (UC04 E2)', () => {
    expect(w.medidaValida('175/70 R13')).toBe(true)
    expect(w.medidaValida('10.00-20')).toBe(true)
    expect(w.medidaValida('11L-15')).toBe(true)
    expect(w.medidaValida('7.50R16LT')).toBe(true)
    expect(w.medidaValida('PNEU GRANDE')).toBe(false)
    expect(w.medidaValida('')).toBe(false)
  })
})

describe('parseMedida — busca maleável pelo índice', () => {
  const indice = { '175/70R13': true, '10.00-20': true, '215/55R17': true, '11L-15': true }

  it('encaixa digitação com espaços na medida existente', () => {
    expect(w.parseMedida('175 70 13', indice)).toBe('175/70R13')
    expect(w.parseMedida('215 55 17', indice)).toBe('215/55R17')
  })

  it('sem índice, devolve o primeiro candidato em vez de quebrar', () => {
    expect(typeof w.parseMedida('175 70 13', null)).toBe('string')
  })
})

describe('medidasCorrespondentes — busca por trecho da medida', () => {
  // Popula o índice pelo caminho real do app (carregarIndiceMedidas lê o banco).
  beforeAll(async () => {
    const app = montarApp({
      resposta: {
        data: [
          { id: 1, medida: '10.00-20', codigo: 'KIT 11.00-22DR9' },
          { id: 2, medida: '215/55 R17', codigo: null },
          { id: 3, medida: '175/70 R13', codigo: 'ABC-123' }
        ],
        error: null
      }
    })
    w2 = app.window
    await w2.carregarIndiceMedidas()
  })
  let w2

  it('"1000" encontra 10.00-20 ignorando a pontuação', () => {
    expect(w2.medidasCorrespondentes('1000')).toContain('10.00-20')
  })

  it('"215 55" encontra 215/55 R17', () => {
    expect(w2.medidasCorrespondentes('215 55')).toContain('215/55 R17')
  })

  it('termo sem correspondência devolve lista vazia, não erro', () => {
    expect(w2.medidasCorrespondentes('999999')).toEqual([])
  })

  it('termo vazio devolve lista vazia', () => {
    expect(w2.medidasCorrespondentes('')).toEqual([])
  })
})

describe('RF02 — validação de CPF e CNPJ', () => {
  it('aceita documentos com dígito verificador correto', () => {
    expect(w.validaCPF('11144477735')).toBe(true)
    expect(w.validaCNPJ('11222333000181')).toBe(true)
  })

  it('recusa dígito verificador errado', () => {
    expect(w.validaCPF('11144477734')).toBe(false)
    expect(w.validaCNPJ('11222333000182')).toBe(false)
  })

  it('recusa sequência repetida e tamanho inválido', () => {
    expect(w.validaCPF('11111111111')).toBe(false)
    expect(w.validaCNPJ('11111111111111')).toBe(false)
    expect(w.validaCPF('123')).toBe(false)
    expect(w.validaCNPJ('123')).toBe(false)
  })

  it('formata para exibição conforme o tipo', () => {
    expect(w.fmtDocumento('11144477735')).toBe('111.444.777-35')
    expect(w.fmtDocumento('11222333000181')).toBe('11.222.333/0001-81')
  })
})

describe('RF15/RN10 — leitura do CSV de importação', () => {
  it('detecta ponto e vírgula como separador', () => {
    const { headers, linhas } = w.parseCSV('medida;marca;custo\n175/70 R13;Pirelli;250,50')
    expect(headers).toEqual(['medida', 'marca', 'custo'])
    expect(linhas[0]).toEqual(['175/70 R13', 'Pirelli', '250,50'])
  })

  it('detecta vírgula como separador', () => {
    const { headers } = w.parseCSV('medida,marca,custo\n175/70 R13,Pirelli,250.50')
    expect(headers).toEqual(['medida', 'marca', 'custo'])
  })

  it('remove o BOM que o Excel grava no início do arquivo', () => {
    const { headers } = w.parseCSV('﻿medida,marca\n175/70 R13,Pirelli')
    expect(headers[0]).toBe('medida')
  })

  it('respeita aspas com separador dentro do campo', () => {
    const { linhas } = w.parseCSV('medida,modelo\n175/70 R13,"SCORPION, HT"')
    expect(linhas[0][1]).toBe('SCORPION, HT')
  })

  it('arquivo vazio não quebra', () => {
    expect(w.parseCSV('')).toEqual({ headers: [], linhas: [] })
  })
})

describe('parseNumeroBR — preço em formato brasileiro', () => {
  it('vírgula decimal', () => expect(w.parseNumeroBR('1.234,56')).toBe(1234.56))
  it('ponto decimal', () => expect(w.parseNumeroBR('1234.56')).toBe(1234.56))
  // ATENÇÃO: comportamento atual, capturado de propósito. "1.234" sem casa
  // decimal é lido como 1,234 — não como mil duzentos e trinta e quatro.
  // Risco real de importação (R$ 1.234 viraria R$ 1,23). Registrado em
  // SUGESTOES.md; mudar isso é decisão de negócio, não conserto de passagem.
  it('"1.234" é lido como decimal, não como milhar (comportamento atual)', () => {
    expect(w.parseNumeroBR('1.234')).toBe(1.234)
  })
  it('com símbolo de moeda', () => expect(w.parseNumeroBR('R$ 250,00')).toBe(250))
  it('vazio devolve NaN em vez de zero', () => expect(w.parseNumeroBR('')).toBeNaN())
  it('nulo devolve NaN', () => expect(w.parseNumeroBR(null)).toBeNaN())
})

describe('RN03/RF28 — cálculo do pedido', () => {
  it('subtotal do item desconta antes de somar', () => {
    expect(w.subtotalItem({ preco_unit: 100, quantidade: 4, desconto_valor: 50 })).toBe(350)
  })

  it('desconto em R$ é usado como valor absoluto', () => {
    w.document.getElementById('ped-desconto').value = '100'
    w.document.getElementById('ped-desconto-tipo').value = 'R$'
    expect(w.descontoTotalCalculado(1000)).toBe(100)
  })

  it('desconto em % é aplicado sobre o total', () => {
    w.document.getElementById('ped-desconto').value = '10'
    w.document.getElementById('ped-desconto-tipo').value = '%'
    expect(w.descontoTotalCalculado(1000)).toBe(100)
  })

  it('percentual acima de 100 é limitado a 100', () => {
    w.document.getElementById('ped-desconto').value = '150'
    w.document.getElementById('ped-desconto-tipo').value = '%'
    expect(w.descontoTotalCalculado(1000)).toBe(1000)
  })

  it('campo de desconto vazio não vira NaN', () => {
    w.document.getElementById('ped-desconto').value = ''
    w.document.getElementById('ped-desconto-tipo').value = 'R$'
    expect(w.descontoTotalCalculado(1000)).toBe(0)
  })
})

describe('segurança — escape de HTML na renderização', () => {
  it('neutraliza script injetado em campo de texto', () => {
    expect(w.esc('<script>alert(1)</script>')).not.toContain('<script>')
    expect(w.esc(`" onerror='x'`)).not.toContain('"')
  })

  it('nulo e indefinido viram string vazia', () => {
    expect(w.esc(null)).toBe('')
    expect(w.esc(undefined)).toBe('')
  })
})

describe('formatação de telefone', () => {
  it('celular com 11 dígitos', () => expect(w.formatTelefone('11987654321')).toBe('(11) 98765-4321'))
  it('fixo com 10 dígitos', () => expect(w.formatTelefone('1133334444')).toBe('(11) 3333-4444'))
  it('entrada vazia não quebra', () => expect(w.formatTelefone('')).toBe(''))
})
