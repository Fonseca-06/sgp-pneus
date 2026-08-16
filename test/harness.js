// Carrega index.html + app.js num jsdom, SEM modificar o código de produção.
// O cliente Supabase é substituído por um duplo que responde a qualquer
// encadeamento (.from().select().eq()... ) e resolve com { data, error }.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')

// Duplo do PostgREST: qualquer método devolve o próprio proxy; await resolve
// com a resposta configurada. Registra as chamadas para inspeção nos testes.
export function criarDbFalso(resposta = { data: [], error: null, count: 0 }) {
  const chamadas = []
  const fazerProxy = () => new Proxy(function () {}, {
    get(_alvo, prop) {
      if (prop === 'then') {
        return (aceitar) => aceitar(resposta)
      }
      if (typeof prop === 'symbol') return undefined
      return (...args) => { chamadas.push({ metodo: prop, args }); return fazerProxy() }
    },
    apply() { return fazerProxy() }
  })
  const db = fazerProxy()
  return { db, chamadas, definirResposta(r) { resposta = r } }
}

// Sobe a aplicação e devolve a window já com app.js avaliado.
export function montarApp({ resposta } = {}) {
  const html = readFileSync(join(raiz, 'index.html'), 'utf8')
  const codigo = readFileSync(join(raiz, 'app.js'), 'utf8')
  const falso = criarDbFalso(resposta)

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

// Atalho para os testes que só exercitam as funções puras.
export function carregarFuncoes() {
  const { window } = montarApp()
  return window
}
