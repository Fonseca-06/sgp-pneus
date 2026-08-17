// Carrega index.html + app.js num jsdom, SEM modificar o código de produção.
// O cliente Supabase é substituído por um duplo que responde a qualquer
// encadeamento (.from().select().eq()... ) e resolve com { data, error }.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')

// Sessão padrão: representante autenticada. Os testes que exercitam as telas
// pressupõem alguém logado — é o estado normal do app depois da F2.
export const SESSAO_PADRAO = {
  user: { id: '11111111-1111-1111-1111-111111111111', email: 'fernanda@teste.local' }
}

// Duplo do PostgREST: qualquer método devolve o próprio proxy; await resolve
// com a resposta configurada. Registra as chamadas para inspeção nos testes.
// `auth` é a exceção — devolve um duplo próprio, com sessão controlável.
export function criarDbFalso(resposta = { data: [], error: null, count: 0 }, opcoes = {}) {
  const chamadas = []
  const authChamadas = []
  let sessao = opcoes.sessao === undefined ? SESSAO_PADRAO : opcoes.sessao
  const erroLogin = opcoes.erroLogin || null
  const ouvintes = []

  const auth = {
    async getSession() {
      authChamadas.push({ metodo: 'getSession' })
      return { data: { session: sessao }, error: null }
    },
    async signInWithPassword(credenciais) {
      authChamadas.push({ metodo: 'signInWithPassword', credenciais })
      if (erroLogin) return { data: { session: null }, error: { message: erroLogin } }
      sessao = opcoes.sessaoAposLogin || SESSAO_PADRAO
      return { data: { session: sessao }, error: null }
    },
    async signOut() {
      authChamadas.push({ metodo: 'signOut' })
      sessao = null
      ouvintes.forEach(cb => cb('SIGNED_OUT', null))
      return { error: null }
    },
    onAuthStateChange(cb) {
      ouvintes.push(cb)
      return { data: { subscription: { unsubscribe() {} } } }
    }
  }

  const fazerProxy = () => new Proxy(function () {}, {
    get(_alvo, prop) {
      if (prop === 'auth') return auth
      if (prop === 'then') {
        return (aceitar) => aceitar(resposta)
      }
      if (typeof prop === 'symbol') return undefined
      return (...args) => { chamadas.push({ metodo: prop, args }); return fazerProxy() }
    },
    apply() { return fazerProxy() }
  })
  const db = fazerProxy()
  return {
    db, chamadas, authChamadas,
    definirResposta(r) { resposta = r },
    sessaoAtual() { return sessao }
  }
}

// Sobe a aplicação e devolve a window já com app.js avaliado.
// `sessao: null` simula ninguém logado.
export function montarApp({ resposta, sessao, sessaoAposLogin, erroLogin } = {}) {
  const html = readFileSync(join(raiz, 'index.html'), 'utf8')
  const codigo = readFileSync(join(raiz, 'app.js'), 'utf8')
  const falso = criarDbFalso(resposta, { sessao, sessaoAposLogin, erroLogin })

  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'http://localhost:8020/',
    pretendToBeVisual: true
  })
  const { window } = dom

  // Stub do SDK que o index.html carrega por CDN (não há rede no teste).
  window.supabase = { createClient: () => falso.db }
  window.fetch = async () => ({ ok: true, json: async () => ({}) })

  window.eval(codigo)

  return { window, dom, ...falso }
}

// Espera a fila de microtasks drenar — a verificação de sessão é assíncrona.
export const assentar = () => new Promise(r => setTimeout(r, 0))

// Atalho para os testes que só exercitam as funções puras.
export function carregarFuncoes() {
  const { window } = montarApp()
  return window
}
