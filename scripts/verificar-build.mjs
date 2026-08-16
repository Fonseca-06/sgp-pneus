// Gate "build" de um projeto sem bundler: garante que os arquivos servidos
// ao navegador estão sintaticamente válidos e coerentes entre si.
// Falha com código != 0 para que `npm run build` sirva de portão.
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const erros = []

const obrigatorios = ['index.html', 'app.js', 'style.css', 'server.py']
for (const arquivo of obrigatorios) {
  if (!existsSync(join(raiz, arquivo))) erros.push(`arquivo obrigatório ausente: ${arquivo}`)
}

// 1. Sintaxe do JavaScript servido ao navegador.
try {
  execFileSync(process.execPath, ['--check', join(raiz, 'app.js')], { stdio: 'pipe' })
} catch (e) {
  erros.push(`app.js não passa em node --check:\n${e.stderr?.toString() || e.message}`)
}

const html = readFileSync(join(raiz, 'index.html'), 'utf8')
const js = readFileSync(join(raiz, 'app.js'), 'utf8')

// 2. Todo getElementById('x') do app precisa existir: ou no index.html, ou
//    criado em runtime pelo próprio app (template literal com id="x").
//    É a classe de erro que mais quebra esta aplicação em produção.
const idsDisponiveis = new Set([
  ...[...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]),
  ...[...js.matchAll(/\bid="([^"$]+)"/g)].map(m => m[1])
])
const idsUsados = new Set([...js.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)].map(m => m[1]))
for (const id of idsUsados) {
  if (!idsDisponiveis.has(id)) {
    erros.push(`app.js usa getElementById('${id}') mas esse id não existe no index.html nem é criado em runtime`)
  }
}

// 3. Cache-bust: o index precisa referenciar app.js e style.css versionados.
if (!/app\.js\?v=\d+/.test(html)) erros.push('index.html deve referenciar app.js com ?v=N (cache-bust)')
if (!/style\.css\?v=\d+/.test(html)) erros.push('index.html deve referenciar style.css com ?v=N (cache-bust)')

// 4. Nenhum segredo de servidor no código do cliente.
if (/service_role|SUPABASE_SERVICE/i.test(js)) {
  erros.push('app.js contém referência a service_role — a chave de servidor nunca vai para o cliente')
}

if (erros.length) {
  console.error('BUILD FALHOU\n')
  for (const e of erros) console.error('  ✗ ' + e)
  process.exit(1)
}

console.log(`build ok — ${obrigatorios.length} arquivos, ${idsUsados.size} ids conferidos contra o HTML`)
