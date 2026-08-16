// F3 — camada única de consulta por documento (R2, R3, R4).
// Cobre os cinco estados exigidos: encontrado, fora da base, documento
// inválido, erro de rede e timeout.
import { describe, it, expect } from 'vitest'
import { montarApp } from './harness.js'

const CPF_OK = '11144477735'
const CNPJ_OK = '11222333000181'

// Os estados são comparados pelo literal: é o contrato da camada,
// não um detalhe de como a constante é declarada.
function app(resposta) {
  return montarApp({ resposta }).window
}

describe('normalização e máscara', () => {
  const w = app({ data: [], error: null })

  it('aceita documento com máscara', () => {
    expect(w.normalizarDocumento('111.444.777-35')).toBe(CPF_OK)
    expect(w.normalizarDocumento('11.222.333/0001-81')).toBe(CNPJ_OK)
  })

  it('identifica o tipo pelo tamanho', () => {
    expect(w.tipoDocumento(CPF_OK)).toBe('PF')
    expect(w.tipoDocumento(CNPJ_OK)).toBe('PJ')
    expect(w.tipoDocumento('123')).toBe(null)
  })

  it('nunca devolve o documento inteiro na máscara (dado pessoal)', () => {
    const m = w.mascararDocumento(CPF_OK)
    expect(m).not.toBe(CPF_OK)
    expect(m).not.toContain('44477')
    expect(m.startsWith('111')).toBe(true)
    expect(m.endsWith('35')).toBe(true)
  })
})

describe('estado ENCONTRADO', () => {
  it('devolve os dados do cliente achado na base', async () => {
    const w = app({ data: [{ id: 7, nome: 'Transportes Silva', documento: CNPJ_OK, cidade: 'Belo Horizonte', uf: 'MG' }], error: null })
    const r = await w.consultarPorDocumento('11.222.333/0001-81')
    expect(r.estado).toBe('ENCONTRADO')
    expect(r.dados.nome).toBe('Transportes Silva')
    expect(r.tipo).toBe('PJ')
    expect(r.documento).toBe(CNPJ_OK)
  })
})

describe('estado FORA_DA_BASE', () => {
  it('documento válido sem correspondência avisa e libera cadastro manual', async () => {
    const w = app({ data: [], error: null })
    const r = await w.consultarPorDocumento(CPF_OK)
    expect(r.estado).toBe('FORA_DA_BASE')
    expect(r.dados).toBe(null)
    expect(r.mensagem.toLowerCase()).toContain('fora da base')
  })

  it('data nulo é tratado como fora da base, não como erro', async () => {
    const w = app({ data: null, error: null })
    const r = await w.consultarPorDocumento(CPF_OK)
    expect(r.estado).toBe('FORA_DA_BASE')
  })
})

describe('estado DOCUMENTO_INVALIDO — validado antes de consultar', () => {
  it('CPF com dígito verificador errado não consulta a base', async () => {
    const montado = montarApp({ resposta: { data: [], error: null } })
    const r = await montado.window.consultarPorDocumento('11144477734')
    expect(r.estado).toBe('DOCUMENTO_INVALIDO')
    // regra 4 do briefing: valida o formato ANTES de consultar
    const consultouCliente = montado.chamadas.some(c => c.metodo === 'from' && c.args[0] === 'cliente')
    expect(consultouCliente).toBe(false)
  })

  it('CNPJ com dígito verificador errado é recusado', async () => {
    const w = app({ data: [], error: null })
    const r = await w.consultarPorDocumento('11222333000182')
    expect(r.estado).toBe('DOCUMENTO_INVALIDO')
    expect(r.mensagem).toContain('CNPJ')
  })

  it('documento incompleto pede o tamanho certo, sem acusar erro de dígito', async () => {
    const w = app({ data: [], error: null })
    const r = await w.consultarPorDocumento('111444')
    expect(r.estado).toBe('INCOMPLETO')
    expect(r.mensagem).toContain('11 dígitos')
  })

  it('entrada vazia não quebra', async () => {
    const w = app({ data: [], error: null })
    expect((await w.consultarPorDocumento('')).estado).toBe('INCOMPLETO')
    expect((await w.consultarPorDocumento(null)).estado).toBe('INCOMPLETO')
  })
})

describe('estado ERRO — falha do banco', () => {
  it('erro do PostgREST vira mensagem ao usuário, sem detalhe técnico', async () => {
    const w = app({ data: null, error: { message: 'permission denied for relation cliente', code: '42501' } })
    const r = await w.consultarPorDocumento(CPF_OK)
    expect(r.estado).toBe('ERRO')
    expect(r.mensagem).not.toContain('permission denied')
    expect(r.mensagem).not.toContain('42501')
  })
})

describe('estado TIMEOUT', () => {
  it('consulta que não responde devolve TIMEOUT em vez de travar a tela', async () => {
    const montado = montarApp()
    // substitui a origem por uma promessa que nunca resolve
    montado.window.eval('buscarNaBase = () => new Promise(() => {})')
    const r = await montado.window.consultarPorDocumento(CPF_OK, { timeoutMs: 30 })
    expect(r.estado).toBe('TIMEOUT')
    expect(r.mensagem.toLowerCase()).toContain('demorou')
  })
})

describe('exceção inesperada', () => {
  it('origem que lança é convertida em estado ERRO, nunca em exceção', async () => {
    const montado = montarApp()
    montado.window.eval('buscarNaBase = () => { throw new Error("boom") }')
    const r = await montado.window.consultarPorDocumento(CPF_OK)
    expect(r.estado).toBe('ERRO')
  })
})
