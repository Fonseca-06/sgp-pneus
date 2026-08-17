// F2 — sessão. Antes disto o app abria direto na base de 48.891 pessoas.
// Cada teste aqui falha se a porta for reaberta.
import { describe, it, expect } from 'vitest'
import { montarApp, assentar, SESSAO_PADRAO } from './harness.js'

const entrar = async (w, email, senha) => {
  w.document.getElementById('login-email').value = email
  w.document.getElementById('login-senha').value = senha
  w.document.getElementById('form-login').dispatchEvent(
    new w.Event('submit', { cancelable: true })
  )
  await assentar()
  await assentar()
}

describe('F2 — sem sessão', () => {
  it('mostra o login e esconde o sistema', async () => {
    const { window: w } = montarApp({ sessao: null })
    await assentar()

    expect(w.document.getElementById('tela-login').className).not.toContain('oculta')
    expect(w.document.body.className).toContain('sem-sessao')
  })

  it('não consulta a base de clientes antes de autenticar', async () => {
    const montado = montarApp({ sessao: null })
    await assentar()
    await assentar()

    const tabelas = montado.chamadas
      .filter(c => c.metodo === 'from')
      .map(c => c.args[0])
    expect(tabelas).not.toContain('cliente')
    expect(tabelas).not.toContain('produto')
  })
})

describe('F2 — com sessão', () => {
  it('esconde o login e libera o sistema', async () => {
    const { window: w } = montarApp()
    await assentar()

    expect(w.document.getElementById('tela-login').className).toContain('oculta')
    expect(w.document.body.className).not.toContain('sem-sessao')
  })

  it('identifica quem está logado no cabeçalho', async () => {
    const montado = montarApp({ resposta: { data: [{ nome: 'Fernanda', perfil: 'REPRESENTANTE' }], error: null } })
    await assentar()
    await assentar()

    expect(montado.window.document.getElementById('sessao-usuario').textContent)
      .toBe('Fernanda')
  })
})

describe('F2 — entrar', () => {
  it('credencial correta abre o sistema', async () => {
    const montado = montarApp({ sessao: null, sessaoAposLogin: SESSAO_PADRAO })
    const w = montado.window
    await assentar()

    await entrar(w, 'fernanda@teste.local', 'senha-certa')

    expect(w.document.getElementById('tela-login').className).toContain('oculta')
    expect(montado.authChamadas.some(c => c.metodo === 'signInWithPassword')).toBe(true)
  })

  it('credencial errada mantém a porta fechada e não entrega quem tem conta', async () => {
    const montado = montarApp({ sessao: null, erroLogin: 'Invalid login credentials' })
    const w = montado.window
    await assentar()

    await entrar(w, 'quemquer@teste.local', 'senha-errada')

    const erro = w.document.getElementById('login-erro')
    expect(erro.className).not.toContain('oculta')
    // Mensagem genérica: não pode revelar se o e-mail existe.
    expect(erro.textContent).toBe('E-mail ou senha inválidos.')
    expect(erro.textContent).not.toMatch(/não existe|não encontrado|cadastrad/i)
    expect(w.document.getElementById('tela-login').className).not.toContain('oculta')
    expect(w.document.body.className).toContain('sem-sessao')
  })

  it('a senha digitada não fica no DOM depois de entrar', async () => {
    const montado = montarApp({ sessao: null, sessaoAposLogin: SESSAO_PADRAO })
    const w = montado.window
    await assentar()

    await entrar(w, 'fernanda@teste.local', 'senha-certa')

    expect(w.document.getElementById('login-senha').value).toBe('')
  })
})

describe('F2 — sair', () => {
  it('derruba a sessão e volta para o login', async () => {
    const montado = montarApp()
    const w = montado.window
    await assentar()
    expect(w.document.getElementById('tela-login').className).toContain('oculta')

    w.document.getElementById('btn-sair').dispatchEvent(new w.Event('click'))
    await assentar()
    await assentar()

    expect(montado.authChamadas.some(c => c.metodo === 'signOut')).toBe(true)
    expect(montado.sessaoAtual()).toBeNull()
    expect(w.document.getElementById('tela-login').className).not.toContain('oculta')
    expect(w.document.body.className).toContain('sem-sessao')
  })
})
