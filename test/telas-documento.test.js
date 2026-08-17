// F4 e F5 — as duas telas que consomem a camada de consulta.
// R3: cadastro autopreenche por CPF/CNPJ, avisa quando o cliente está fora da
//     base e libera o preenchimento manual.
// R4: cabeçalho do pedido informa o CNPJ e puxa os dados da mesma forma.
import { describe, it, expect } from 'vitest'
import { montarApp, assentar } from './harness.js'

const CNPJ_OK = '11222333000181'
const CPF_OK = '11144477735'

const CLIENTE = {
  id: 42, tipo: 'PJ', nome: 'Transportes Silva Ltda', nome_fantasia: 'Silva Transportes',
  documento: CNPJ_OK, telefone: '(31) 3333-4444', celular: '(31) 98888-7777',
  email: 'contato@silva.com.br', cep: '30110000', logradouro: 'Av. Afonso Pena',
  numero: '1500', bairro: 'Centro', cidade: 'Belo Horizonte', uf: 'MG',
  beneficio_fiscal: 'Grupo 106', revenda: true, ativo: true
}

// Dispara o handler de blur do campo e espera a consulta assíncrona resolver.
async function digitarDocumento(w, idCampo, valor) {
  const campo = w.document.getElementById(idCampo)
  campo.value = valor
  campo.dispatchEvent(new w.Event('blur'))
  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))
}

describe('R3 — cadastro: cliente encontrado na base', () => {
  it('autopreenche os campos e passa a editar o registro existente', async () => {
    const { window: w } = montarApp({ resposta: { data: [CLIENTE], error: null } })
    w.document.getElementById('btn-novo-cliente').dispatchEvent(new w.Event('click'))

    await digitarDocumento(w, 'cli-documento', '11.222.333/0001-81')

    expect(w.document.getElementById('cli-nome').value).toBe('Transportes Silva Ltda')
    expect(w.document.getElementById('cli-cidade').value).toBe('Belo Horizonte')
    expect(w.document.getElementById('cli-uf').value).toBe('MG')
    expect(w.document.getElementById('cli-beneficio').value).toBe('Grupo 106')
    // vira edição: evita esbarrar na restrição de documento único ao salvar
    expect(w.document.getElementById('cli-id').value).toBe('42')
    // o tipo é deduzido do documento
    expect(w.document.querySelector('input[name="cli-tipo"]:checked').value).toBe('PJ')
  })

  it('mostra mensagem de sucesso ao usuário', async () => {
    const { window: w } = montarApp({ resposta: { data: [CLIENTE], error: null } })
    w.document.getElementById('btn-novo-cliente').dispatchEvent(new w.Event('click'))
    await digitarDocumento(w, 'cli-documento', CNPJ_OK)

    const status = w.document.getElementById('cli-consulta-status')
    expect(status.className).toContain('ok')
    expect(status.textContent.toLowerCase()).toContain('encontrado')
  })
})

describe('R3 — cadastro: cliente fora da base', () => {
  it('avisa "cliente fora da base" e mantém os campos livres para digitação', async () => {
    const { window: w } = montarApp({ resposta: { data: [], error: null } })
    w.document.getElementById('btn-novo-cliente').dispatchEvent(new w.Event('click'))

    await digitarDocumento(w, 'cli-documento', CPF_OK)

    const status = w.document.getElementById('cli-consulta-status')
    expect(status.textContent.toLowerCase()).toContain('fora da base')
    expect(status.className).toContain('aviso')
    // segue sendo inclusão, não edição
    expect(w.document.getElementById('cli-id').value).toBe('')
    // nada foi preenchido por engano
    expect(w.document.getElementById('cli-nome').value).toBe('')
    // e o tipo foi deduzido do CPF
    expect(w.document.querySelector('input[name="cli-tipo"]:checked').value).toBe('PF')
  })
})

describe('R3 — cadastro: documento inválido e incompleto', () => {
  it('CPF com dígito errado é acusado antes de qualquer consulta', async () => {
    const montado = montarApp({ resposta: { data: [], error: null } })
    const w = montado.window
    w.document.getElementById('btn-novo-cliente').dispatchEvent(new w.Event('click'))
    // A verificação de sessão é assíncrona e também consulta o banco; espera
    // ela terminar para que o contador meça só o que a digitação provocou.
    await assentar()
    montado.chamadas.length = 0

    await digitarDocumento(w, 'cli-documento', '11144477734')

    const status = w.document.getElementById('cli-consulta-status')
    expect(status.className).toContain('erro')
    expect(status.textContent).toContain('CPF inválido')
    expect(montado.chamadas.some(c => c.metodo === 'from')).toBe(false)
  })

  it('documento pela metade não mostra erro nenhum', async () => {
    const { window: w } = montarApp({ resposta: { data: [], error: null } })
    w.document.getElementById('btn-novo-cliente').dispatchEvent(new w.Event('click'))
    await digitarDocumento(w, 'cli-documento', '111444')
    expect(w.document.getElementById('cli-consulta-status').className).toContain('oculta')
  })
})

describe('R3 — cadastro: falha do banco', () => {
  it('erro vira mensagem legível, sem detalhe técnico na tela', async () => {
    const { window: w } = montarApp({
      resposta: { data: null, error: { message: 'permission denied for relation cliente', code: '42501' } }
    })
    w.document.getElementById('btn-novo-cliente').dispatchEvent(new w.Event('click'))
    await digitarDocumento(w, 'cli-documento', CPF_OK)

    const status = w.document.getElementById('cli-consulta-status')
    expect(status.className).toContain('erro')
    expect(status.textContent).not.toContain('permission denied')
    expect(status.textContent).not.toContain('42501')
  })
})

describe('R4 — cabeçalho do pedido', () => {
  it('CNPJ encontrado carrega o cliente no cabeçalho', async () => {
    const { window: w } = montarApp({ resposta: { data: [CLIENTE], error: null } })
    w.document.getElementById('btn-novo-pedido').dispatchEvent(new w.Event('click'))

    await digitarDocumento(w, 'ped-cliente-doc', CNPJ_OK)

    const escolhido = w.document.getElementById('editor-cliente-escolhido')
    expect(escolhido.classList.contains('oculta')).toBe(false)
    expect(escolhido.textContent).toContain('Transportes Silva Ltda')
    // o campo se limpa para o próximo uso
    expect(w.document.getElementById('ped-cliente-doc').value).toBe('')
  })

  it('cliente com benefício fiscal dispara o aviso existente (sem regressão)', async () => {
    const { window: w } = montarApp({ resposta: { data: [CLIENTE], error: null } })
    w.document.getElementById('btn-novo-pedido').dispatchEvent(new w.Event('click'))
    await digitarDocumento(w, 'ped-cliente-doc', CNPJ_OK)

    expect(w.document.getElementById('editor-cliente-aviso').textContent).toContain('benefício fiscal')
  })

  it('CNPJ fora da base avisa e oferece cadastrar na hora', async () => {
    const { window: w } = montarApp({ resposta: { data: [], error: null } })
    w.document.getElementById('btn-novo-pedido').dispatchEvent(new w.Event('click'))

    await digitarDocumento(w, 'ped-cliente-doc', CNPJ_OK)

    const status = w.document.getElementById('ped-consulta-status')
    expect(status.textContent.toLowerCase()).toContain('fora da base')
    expect(status.querySelector('button')).not.toBe(null)
    // o cliente não foi escolhido
    expect(w.document.getElementById('editor-cliente-escolhido').classList.contains('oculta')).toBe(true)
  })

  it('o botão "Cadastrar agora" abre o cadastro já com o documento', async () => {
    const { window: w } = montarApp({ resposta: { data: [], error: null } })
    w.document.getElementById('btn-novo-pedido').dispatchEvent(new w.Event('click'))
    await digitarDocumento(w, 'ped-cliente-doc', CNPJ_OK)

    w.cadastrarClienteDoPedido(CNPJ_OK)
    await new Promise(r => setTimeout(r, 0))

    expect(w.document.getElementById('modal-cliente').classList.contains('oculta')).toBe(false)
    expect(w.document.getElementById('cli-documento').value).toBe('11.222.333/0001-81')
  })
})

describe('não-duplicação — cadastro e pedido usam a mesma camada', () => {
  it('trocar consultarPorDocumento afeta as duas telas', async () => {
    const { window: w } = montarApp({ resposta: { data: [], error: null } })
    // substitui a camada única por um duplo que registra as chamadas
    w.eval(`
      window.__chamadas = []
      consultarPorDocumento = async (doc) => {
        window.__chamadas.push(String(doc).replace(/\\D/g, ''))
        return { estado: 'FORA_DA_BASE', documento: String(doc), tipo: 'PJ', dados: null, mensagem: 'Cliente fora da base — preencha os dados para cadastrar.' }
      }
    `)

    w.document.getElementById('btn-novo-cliente').dispatchEvent(new w.Event('click'))
    await digitarDocumento(w, 'cli-documento', CNPJ_OK)

    w.document.getElementById('btn-novo-pedido').dispatchEvent(new w.Event('click'))
    await digitarDocumento(w, 'ped-cliente-doc', CNPJ_OK)

    // as duas telas passaram pela mesma função
    expect(w.__chamadas).toEqual([CNPJ_OK, CNPJ_OK])
  })
})
