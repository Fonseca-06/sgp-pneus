// F7 — identidade Mira Sales.
// Falha se alguém reintroduzir "SGP" no que o usuário vê ou nos metadados.
// Grafia fixada no PLANO.md §4: pacote `mira-sales` · exibição `Mira Sales`.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { montarApp } from './harness.js'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const ler = (arquivo) => readFileSync(join(raiz, arquivo), 'utf8')

// Registram a migração ou o caminho real no disco do cliente — guardam "SGP"
// de propósito. O critério da F7 é "nenhuma residual FORA de histórico".
const HISTORICO = new Set([
  'PLANO.md',
  'README.md',
  'test/identidade.test.js',
  'test/regressao-dominio.test.js',
  'importar_clientes.py',
  'importar_pneus.py'
])

const arquivosVersionados = () =>
  execFileSync('git', ['-C', raiz, 'ls-files'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => /\.(js|mjs|html|css|py|json|md|csv)$/.test(f))
    .filter((f) => f !== 'package-lock.json')

describe('F7 — identidade do produto', () => {
  it('o título da aba é Mira Sales', () => {
    const { window: w } = montarApp()
    expect(w.document.title).toBe('Mira Sales')
  })

  it('a marca no cabeçalho lê Mira Sales', () => {
    const { window: w } = montarApp()
    const marca = w.document.querySelector('.marca')
    expect(marca).not.toBeNull()
    expect(marca.textContent.replace(/\s+/g, ' ').trim()).toBe('Mira Sales')
  })

  it('o nome do pacote é mira-sales', () => {
    expect(JSON.parse(ler('package.json')).name).toBe('mira-sales')
  })

  it('nenhum arquivo versionado contém "SGP" fora do histórico', () => {
    const residuais = arquivosVersionados()
      .filter((f) => !HISTORICO.has(f))
      .filter((f) => /SGP/i.test(ler(f)))
    expect(residuais).toEqual([])
  })
})
