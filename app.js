const SUPABASE_URL  = 'https://xlpxbqyfdwhmfuoexgwm.supabase.co'
const SUPABASE_ANON = 'sb_publishable_TZfPp_39dCMikhQMFtGfSw_7fQThQ9t'

const { createClient } = supabase
const db = createClient(SUPABASE_URL, SUPABASE_ANON)

// Prazo (em dias) após o qual o preço é sinalizado como desatualizado (RF20)
const DIAS_PRECO_DESATUALIZADO = 30

let fornecedores = []
let indiceMedidas = null   // { medidaNormalizada: true } para o parseMedida "encaixar" a digitação
let importacaoPendente = null

// ─── Utilidades ───────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function fmtReal(v) {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function fmtData(iso) {
  return iso ? new Date(iso).toLocaleDateString('pt-BR') : '—'
}

function diasDesde(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
}

let toastTimer
function toast(msg, erro = false) {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.className = erro ? 'erro' : ''
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('oculta'), 4000)
}

// ─── Medida (mesma lógica do Mira) ────────────────────────────────────────────

function normMedida(m) {
  return (m || '').toUpperCase().replace(/\s+/g, '')
}

// Forma canônica de gravação/exibição (RN01): padrão carro vira "175/70 R13";
// formatos caminhão/agro/OTR (10.00-20, 28X9-15, 11L-15) ficam como estão, maiúsculos
function medidaCanonica(m) {
  const norm = normMedida(m)
  if (/^\d{2,3}(\.\d+)?\/\d{2,3}(\.\d+)?R\d{1,2}(\.\d)?(C|LT)?$/.test(norm)) {
    return norm.replace(/R(\d)/g, ' R$1')
  }
  return norm
}

// Interpreta a medida digitada de formas variadas (175 70 13, 175/70-13, 10.00 20…)
function parseMedida(input, indice) {
  const up = (input || '').toUpperCase()
  const direct = normMedida(up)
  if (indice && indice[direct] !== undefined) return direct
  const suf = (up.match(/(LT|C)\s*$/) || [''])[0].trim()
  const candidatos = []
  for (const nums of [up.match(/\d+\.?\d+|\d+/g), up.match(/\d+/g)]) {
    if (!nums) continue
    if (nums.length >= 3) {
      candidatos.push(normMedida(`${nums[0]}/${nums[1]}R${nums[2]}${suf}`))
      candidatos.push(normMedida(`${nums[0]}/${nums[1]}R${nums[2]}`))
      candidatos.push(normMedida(`${nums[0]}X${nums[1]}-${nums[2]}`))
      candidatos.push(normMedida(`${nums[0]}/${nums[1]}-${nums[2]}`))
    }
    if (nums.length >= 2) {
      candidatos.push(normMedida(`${nums[0]}-${nums[1]}`))
      candidatos.push(normMedida(`${nums[0]}R${nums[1]}${suf}`))
      candidatos.push(normMedida(`${nums[0]}L-${nums[1]}`))
    }
  }
  for (const c of candidatos) if (indice && indice[c] !== undefined) return c
  return candidatos[0] || direct
}

// Medida reconhecível em algum dos padrões do mercado (linhas fora disso são rejeitadas — UC04 E2)
function medidaValida(canonica) {
  return [
    /^\d{2,3}(\.\d+)?\/\d{2,3}(\.\d+)? R\d{1,2}(\.\d)?(C|LT)?$/,   // 175/70 R13
    /^\d+(\.\d+)?R\d+(\.\d+)?(LT|C)?$/,                            // 7.50R16LT, 185R14C
    /^\d+(\.\d+)?-\d+(\.\d+)?$/,                                   // 10.00-20, 10-16.5
    /^\d+(\.\d+)?X\d+(\.\d+)?(-\d+(\.\d+)?)?(R\d+(\.\d+)?)?$/,     // 28X9-15, 31X10.50R15
    /^\d+(\.\d+)?\/\d+(\.\d+)?$/,                                  // 12.00/24
    /^\d+(\.\d+)?\/\d+(\.\d+)?(-|R)\d+(\.\d+)?(C|LT)?$/,           // 12.5/80-18, 400/60-15.5
    /^\d+(\.\d+)?L-\d+(\.\d+)?$/                                   // 11L-15 (agrícola)
  ].some(re => re.test(canonica))
}

// ─── CSV (aceita , ou ; como separador, BOM do Excel e preço com vírgula) ─────

function splitCSVLine(line, delim) {
  const out = []
  let cur = '', inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') inQuotes = false
      else cur += c
    } else if (c === '"') inQuotes = true
    else if (c === delim) { out.push(cur); cur = '' }
    else cur += c
  }
  out.push(cur)
  return out.map(v => v.trim())
}

function parseCSV(text) {
  const semBom = text.replace(/^﻿/, '')
  const lines = semBom.trim().split(/\r?\n/).filter(l => l.trim())
  if (!lines.length) return { headers: [], linhas: [] }
  const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ','
  const headers = splitCSVLine(lines[0], delim).map(h => h.toLowerCase())
  const linhas = lines.slice(1).map(l => splitCSVLine(l, delim))
  return { headers, linhas }
}

function parseNumeroBR(v) {
  if (v == null) return NaN
  let s = String(v).trim().replace(/[^\d.,-]/g, '')
  if (!s) return NaN
  const ultimaVirgula = s.lastIndexOf(','), ultimoPonto = s.lastIndexOf('.')
  if (ultimaVirgula > ultimoPonto) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  return parseFloat(s)
}

// ─── Navegação por abas ───────────────────────────────────────────────────────

document.querySelectorAll('.aba').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.aba').forEach(b => b.classList.remove('ativa'))
    btn.classList.add('ativa')
    document.querySelectorAll('.tela').forEach(t => t.classList.add('oculta'))
    document.getElementById('tab-' + btn.dataset.tab).classList.remove('oculta')
    if (btn.dataset.tab === 'config') { loadFornecedores(); loadImportacoes() }
    if (btn.dataset.tab === 'clientes') {
      carregarRadar()
      if (!document.getElementById('resultado-clientes').innerHTML) buscarClientes('')
    }
    if (btn.dataset.tab === 'pedidos') {
      document.getElementById('pedido-editor').classList.add('oculta')
      document.getElementById('pedidos-lista').classList.remove('oculta')
      buscarPedidos()
    }
  })
})

// ─── Fornecedores ─────────────────────────────────────────────────────────────

async function loadFornecedores() {
  const { data, error } = await db.from('fornecedor').select('*').order('nome')
  if (error) return toast('Erro ao carregar fornecedores', true)
  fornecedores = data || []
  renderFornecedores()
  preencherSelectsFornecedor()
}

function renderFornecedores() {
  const el = document.getElementById('lista-fornecedores')
  if (!fornecedores.length) { el.innerHTML = '<div class="vazio">Nenhum fornecedor cadastrado.</div>'; return }
  el.innerHTML = `<div class="tabela-scroll"><table>
    <tr><th>Nome</th><th>Contato</th><th>Situação</th><th></th></tr>
    ${fornecedores.map(f => `<tr>
      <td><strong>${esc(f.nome)}</strong></td>
      <td>${esc(f.contato || '—')}</td>
      <td>${f.ativo ? 'Ativo' : '<span class="suave">Inativo</span>'}</td>
      <td><button class="btn mini" onclick="toggleFornecedor(${f.id}, ${!f.ativo})">${f.ativo ? 'Inativar' : 'Reativar'}</button></td>
    </tr>`).join('')}
  </table></div>`
}

function preencherSelectsFornecedor() {
  const ativos = fornecedores.filter(f => f.ativo)
  const opts = '<option value="">Selecione...</option>' +
    ativos.map(f => `<option value="${f.id}">${esc(f.nome)}</option>`).join('')
  document.getElementById('prod-fornecedor').innerHTML = opts
  document.getElementById('imp-fornecedor').innerHTML = opts
}

document.getElementById('form-fornecedor').addEventListener('submit', async e => {
  e.preventDefault()
  const nome = document.getElementById('forn-nome').value.trim()
  const contato = document.getElementById('forn-contato').value.trim() || null
  if (!nome) return
  const { error } = await db.from('fornecedor').insert({ nome, contato })
  if (error) return toast(error.code === '23505' ? 'Já existe fornecedor com esse nome' : 'Erro ao gravar fornecedor', true)
  document.getElementById('form-fornecedor').reset()
  toast('Fornecedor cadastrado')
  loadFornecedores()
})

window.toggleFornecedor = async (id, ativo) => {
  const { error } = await db.from('fornecedor').update({ ativo }).eq('id', id)
  if (error) return toast('Erro ao alterar fornecedor', true)
  loadFornecedores()
}

// ─── Busca de produtos por medida (RF12, RF13) ────────────────────────────────

let indiceCodigos = []

async function carregarIndiceMedidas() {
  const { data } = await db.from('produto').select('id, medida, codigo').eq('ativo', true).limit(10000)
  indiceMedidas = {}
  indiceCodigos = []
  for (const p of (data || [])) {
    indiceMedidas[normMedida(p.medida)] = p.medida
    if (p.codigo) indiceCodigos.push({ a: p.codigo.toUpperCase().replace(/[^A-Z0-9]/g, ''), id: p.id })
  }
}

// Busca maleável: casa a sequência digitada (só dígitos, ou dígitos+letras) com
// qualquer trecho das medidas conhecidas — "1000" acha 10.00-20, "215 55" acha 215/55R17
function medidasCorrespondentes(termo) {
  const alnum = (termo || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!alnum || !indiceMedidas) return []
  const soDigitos = !/[A-Z]/.test(alnum)
  const alvo = soDigitos ? alnum.replace(/\D/g, '') : alnum
  const out = []
  for (const [norm, stored] of Object.entries(indiceMedidas)) {
    const chave = soDigitos ? norm.replace(/\D/g, '') : norm.replace(/[^A-Z0-9]/g, '')
    if (chave.includes(alvo)) out.push(stored)
  }
  return [...new Set(out)].slice(0, 60)
}

// Consulta compartilhada (aba Produtos e editor de pedido): medida maleável OU código do fornecedor
async function consultarProdutos(termo, limite) {
  if (indiceMedidas === null) await carregarIndiceMedidas()
  let query = db.from('produto')
    .select('*, fornecedor(nome)')
    .eq('ativo', true)
    .order('preco_venda', { ascending: true })
    .limit(limite)

  const t = (termo || '').trim()
  const medidas = medidasCorrespondentes(t)
  if (!medidas.length) {
    const chave = parseMedida(t, indiceMedidas)
    if (indiceMedidas[chave]) medidas.push(indiceMedidas[chave])
  }
  const filtros = []
  if (medidas.length) filtros.push(`medida.in.(${medidas.map(m => `"${m}"`).join(',')})`)
  // código também maleável: compara ignorando pontos, hífens e espaços
  const alnumT = t.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (alnumT.length >= 3) {
    const ids = indiceCodigos.filter(c => c.a.includes(alnumT)).map(c => c.id).slice(0, 60)
    if (ids.length) filtros.push(`id.in.(${ids.join(',')})`)
  }
  if (!filtros.length) return { data: [] }
  return query.or(filtros.join(','))
}

async function buscarProdutos(termo) {
  const el = document.getElementById('resultado-busca')
  let resultado
  if (termo && termo.trim()) {
    resultado = await consultarProdutos(termo, 100)
  } else {
    resultado = await db.from('produto')
      .select('*, fornecedor(nome)')
      .eq('ativo', true)
      .order('atualizado_em', { ascending: false })
      .order('preco_venda', { ascending: true })
      .limit(50)
  }
  if (resultado.error) { el.innerHTML = '<div class="vazio">Erro ao consultar produtos.</div>'; return }
  renderProdutos(resultado.data || [], termo)
}

function renderProdutos(produtos, termo) {
  const el = document.getElementById('resultado-busca')
  if (!produtos.length) {
    el.innerHTML = `<div class="vazio">${termo ? 'Nenhum pneu encontrado para essa medida.' : 'Nenhum produto cadastrado ainda. Use "Importar CSV" ou "+ Novo produto".'}</div>`
    return
  }
  el.innerHTML = `<div class="tabela-scroll"><table>
    <tr><th>Medida</th><th>Marca</th><th>Modelo</th><th>Índices</th><th>Fornecedor</th><th>Preço</th><th>Atualizado</th><th></th></tr>
    ${produtos.map(p => {
      const dias = diasDesde(p.atualizado_em)
      const desatualizado = dias > DIAS_PRECO_DESATUALIZADO
      return `<tr>
        <td class="medida-tag">${esc(p.medida)}</td>
        <td>${esc(p.marca)}</td>
        <td>${esc(p.modelo)}${p.codigo ? `<br><span class="suave">${esc(p.codigo)}</span>` : ''}</td>
        <td class="suave">${esc([p.indice_carga, p.indice_veloc].filter(Boolean).join(' ') || '—')}</td>
        <td>${esc(p.fornecedor?.nome || '—')}</td>
        <td class="preco">${fmtReal(p.preco_venda)}</td>
        <td>${fmtData(p.atualizado_em)} ${desatualizado ? '<span class="badge desatualizado">desatualizado</span>' : ''}<br><span class="badge origem">${esc(p.origem_preco)}</span></td>
        <td><button class="btn mini" onclick='editarProduto(${JSON.stringify(p).replace(/'/g, "&#39;")})'>Editar</button></td>
      </tr>`
    }).join('')}
  </table></div>`
}

let buscaTimer
document.getElementById('busca-medida').addEventListener('input', e => {
  clearTimeout(buscaTimer)
  buscaTimer = setTimeout(() => buscarProdutos(e.target.value), 300)
})

// ─── Cadastro manual de produto (RF10, RF14, RF21) ────────────────────────────

document.getElementById('btn-novo-produto').addEventListener('click', async () => {
  if (!fornecedores.length) await loadFornecedores()
  if (!fornecedores.filter(f => f.ativo).length) {
    return toast('Cadastre um fornecedor primeiro (aba Configurações)', true)
  }
  document.getElementById('modal-produto-titulo').textContent = 'Novo produto'
  document.getElementById('form-produto').reset()
  document.getElementById('prod-id').value = ''
  document.getElementById('prod-fornecedor').disabled = false
  document.getElementById('modal-produto').classList.remove('oculta')
})

window.editarProduto = p => {
  document.getElementById('modal-produto-titulo').textContent = 'Editar produto'
  document.getElementById('prod-id').value = p.id
  document.getElementById('prod-fornecedor').value = p.fornecedor_id
  document.getElementById('prod-fornecedor').disabled = true
  document.getElementById('prod-medida').value = p.medida
  document.getElementById('prod-marca').value = p.marca
  document.getElementById('prod-modelo').value = p.modelo
  document.getElementById('prod-codigo').value = p.codigo || ''
  document.getElementById('prod-carga').value = p.indice_carga || ''
  document.getElementById('prod-veloc').value = p.indice_veloc || ''
  document.getElementById('prod-custo').value = String(p.custo).replace('.', ',')
  document.getElementById('prod-venda').value = String(p.preco_venda).replace('.', ',')
  document.getElementById('modal-produto').classList.remove('oculta')
}

document.getElementById('btn-cancelar-produto').addEventListener('click', () => {
  document.getElementById('modal-produto').classList.add('oculta')
})

document.getElementById('form-produto').addEventListener('submit', async e => {
  e.preventDefault()
  const id = document.getElementById('prod-id').value
  const medida = medidaCanonica(document.getElementById('prod-medida').value)
  if (!medidaValida(medida)) return toast('Medida não reconhecida. Use o padrão 175/70 R13.', true)
  const custo = parseNumeroBR(document.getElementById('prod-custo').value)
  const preco_venda = parseNumeroBR(document.getElementById('prod-venda').value)
  if (isNaN(custo) || isNaN(preco_venda)) return toast('Custo e preço de venda devem ser numéricos', true)

  const registro = {
    fornecedor_id: Number(document.getElementById('prod-fornecedor').value),
    medida,
    marca: document.getElementById('prod-marca').value.trim(),
    modelo: document.getElementById('prod-modelo').value.trim(),
    codigo: document.getElementById('prod-codigo').value.trim() || null,
    indice_carga: document.getElementById('prod-carga').value.trim() || null,
    indice_veloc: document.getElementById('prod-veloc').value.trim() || null,
    custo, preco_venda,
    origem_preco: 'MANUAL',
    atualizado_em: new Date().toISOString()
  }

  if (id) {
    const { data: ant } = await db.from('produto').select('custo, preco_venda').eq('id', id).single()
    const { error } = await db.from('produto').update(registro).eq('id', id)
    if (error) return toast(error.code === '23505' ? 'Já existe produto com essa combinação de fornecedor, medida, marca e modelo' : 'Erro ao gravar produto', true)
    if (ant && (Number(ant.custo) !== custo || Number(ant.preco_venda) !== preco_venda)) {
      await db.from('historico_preco').insert({
        produto_id: Number(id), custo_ant: ant.custo, custo_novo: custo,
        venda_ant: ant.preco_venda, venda_novo: preco_venda, origem: 'MANUAL'
      })
    }
    toast('Produto atualizado')
  } else {
    const { data, error } = await db.from('produto').insert(registro).select().single()
    if (error) return toast(error.code === '23505' ? 'Já existe produto com essa combinação de fornecedor, medida, marca e modelo' : 'Erro ao gravar produto', true)
    await db.from('historico_preco').insert({
      produto_id: data.id, custo_novo: custo, venda_novo: preco_venda, origem: 'MANUAL'
    })
    toast('Produto cadastrado')
  }
  document.getElementById('modal-produto').classList.add('oculta')
  indiceMedidas = null
  buscarProdutos(document.getElementById('busca-medida').value)
})

// ─── Importação de CSV (RF15–RF18, RN10) ──────────────────────────────────────

// Aliases aceitos para cada campo no cabeçalho do arquivo
const COLUNAS = {
  medida:       ['medida', 'medidas', 'dimensao', 'tamanho'],
  marca:        ['marca', 'fabricante'],
  modelo:       ['modelo', 'desenho', 'linha', 'descricao'],
  custo:        ['custo', 'preco', 'preço', 'preco_custo', 'valor', 'preco unitario'],
  preco_venda:  ['preco_venda', 'preço_venda', 'venda', 'preco de venda', 'preco sugerido', 'sugerido'],
  indice_carga: ['indice_carga', 'carga', 'indice de carga', 'ic'],
  indice_veloc: ['indice_veloc', 'velocidade', 'indice de velocidade', 'iv', 'indice_velocidade']
}
const OBRIGATORIAS = ['medida', 'marca', 'modelo', 'custo']

function normHeader(h) {
  return h.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 _]/g, '').trim()
}

function mapearColunas(headers) {
  const norm = headers.map(normHeader)
  const mapa = {}
  for (const [campo, aliases] of Object.entries(COLUNAS)) {
    const idx = norm.findIndex(h => aliases.includes(h))
    if (idx >= 0) mapa[campo] = idx
  }
  return mapa
}

document.getElementById('btn-importar').addEventListener('click', async () => {
  if (!fornecedores.length) await loadFornecedores()
  if (!fornecedores.filter(f => f.ativo).length) {
    return toast('Cadastre um fornecedor primeiro (aba Configurações)', true)
  }
  importacaoPendente = null
  document.getElementById('imp-passo1').classList.remove('oculta')
  document.getElementById('imp-passo2').classList.add('oculta')
  document.getElementById('imp-passo3').classList.add('oculta')
  document.getElementById('imp-arquivo').value = ''
  document.getElementById('modal-importar').classList.remove('oculta')
})

document.querySelectorAll('[data-fechar-imp]').forEach(b =>
  b.addEventListener('click', () => {
    document.getElementById('modal-importar').classList.add('oculta')
    importacaoPendente = null
  })
)

document.getElementById('btn-analisar').addEventListener('click', async () => {
  const fornecedorId = Number(document.getElementById('imp-fornecedor').value)
  const arquivo = document.getElementById('imp-arquivo').files[0]
  if (!fornecedorId) return toast('Selecione o fornecedor', true)
  if (!arquivo) return toast('Selecione o arquivo CSV', true)

  const texto = await arquivo.text()
  const { headers, linhas } = parseCSV(texto)
  const mapa = mapearColunas(headers)

  // RF18/RN10: layout incompatível → recusa integral
  const faltando = OBRIGATORIAS.filter(c => !(c in mapa))
  if (faltando.length) {
    document.getElementById('imp-passo1').classList.add('oculta')
    document.getElementById('imp-passo3').classList.remove('oculta')
    document.getElementById('imp-resultado').innerHTML = `
      <div class="resumo-imp"><div class="resumo-item erro"><div class="num">✕</div><div class="rotulo">Arquivo recusado</div></div></div>
      <p><strong>Colunas obrigatórias não encontradas:</strong> ${faltando.map(esc).join(', ')}</p>
      <p class="dica">Colunas encontradas no arquivo: ${headers.map(esc).join(', ') || 'nenhuma'}<br>
      Nenhum registro foi criado ou alterado.</p>`
    return
  }

  // Valida linha a linha; rejeitadas ficam só no relatório (UC04 E2)
  const itensPorChave = {}
  const rejeitadas = []
  linhas.forEach((cols, i) => {
    const linhaNum = i + 2
    const medida = medidaCanonica(parseMedida(cols[mapa.medida] || ''))
    const marca = (cols[mapa.marca] || '').trim()
    const modelo = (cols[mapa.modelo] || '').trim()
    const custo = parseNumeroBR(cols[mapa.custo])
    const venda = 'preco_venda' in mapa ? parseNumeroBR(cols[mapa.preco_venda]) : NaN

    if (!medidaValida(medida)) return rejeitadas.push({ linha: linhaNum, motivo: `Medida irreconhecível: "${cols[mapa.medida] || ''}"` })
    if (!marca) return rejeitadas.push({ linha: linhaNum, motivo: 'Marca vazia' })
    if (!modelo) return rejeitadas.push({ linha: linhaNum, motivo: 'Modelo vazio' })
    if (isNaN(custo) || custo < 0) return rejeitadas.push({ linha: linhaNum, motivo: `Custo não numérico: "${cols[mapa.custo] || ''}"` })

    const item = { medida, marca, modelo, custo: custo.toFixed(2) }
    if (!isNaN(venda) && venda >= 0) item.preco_venda = venda.toFixed(2)
    if ('indice_carga' in mapa) item.indice_carga = (cols[mapa.indice_carga] || '').trim()
    if ('indice_veloc' in mapa) item.indice_veloc = (cols[mapa.indice_veloc] || '').trim()

    const chave = `${normMedida(medida)}|${marca.toUpperCase()}|${modelo.toUpperCase()}`
    if (itensPorChave[chave]) rejeitadas.push({ linha: itensPorChave[chave].linha, motivo: 'Duplicada no arquivo (prevaleceu a última ocorrência)' })
    itensPorChave[chave] = { linha: linhaNum, item }
  })
  const itens = Object.values(itensPorChave).map(x => x.item)

  // Prévia criar × atualizar: compara com o que já existe na base (RN02)
  const { data: existentes, error } = await db.from('produto')
    .select('medida, marca, modelo').eq('fornecedor_id', fornecedorId)
  if (error) return toast('Erro ao consultar a base para a prévia', true)
  const chavesExistentes = new Set((existentes || []).map(p =>
    `${normMedida(p.medida)}|${p.marca.toUpperCase()}|${p.modelo.toUpperCase()}`))
  const criar = itens.filter(it => !chavesExistentes.has(`${normMedida(it.medida)}|${it.marca.toUpperCase()}|${it.modelo.toUpperCase()}`)).length
  const atualizar = itens.length - criar

  importacaoPendente = { fornecedorId, arquivoNome: arquivo.name, itens, rejeitadas }

  document.getElementById('imp-resumo').innerHTML = `
    <div class="resumo-imp">
      <div class="resumo-item ok"><div class="num">${criar}</div><div class="rotulo">a criar</div></div>
      <div class="resumo-item"><div class="num">${atualizar}</div><div class="rotulo">a atualizar</div></div>
      <div class="resumo-item ${rejeitadas.length ? 'alerta' : ''}"><div class="num">${rejeitadas.length}</div><div class="rotulo">rejeitadas</div></div>
    </div>`
  document.getElementById('imp-rejeitados').innerHTML = rejeitadas.length ? `
    <div class="tabela-scroll" style="max-height:200px;overflow-y:auto"><table>
      <tr><th>Linha</th><th>Motivo</th></tr>
      ${rejeitadas.map(r => `<tr><td>${r.linha}</td><td>${esc(r.motivo)}</td></tr>`).join('')}
    </table></div>` : ''
  document.getElementById('imp-passo1').classList.add('oculta')
  document.getElementById('imp-passo2').classList.remove('oculta')
})

document.getElementById('btn-confirmar-imp').addEventListener('click', async () => {
  if (!importacaoPendente) return
  const { fornecedorId, arquivoNome, itens, rejeitadas } = importacaoPendente
  const btn = document.getElementById('btn-confirmar-imp')
  btn.disabled = true
  btn.textContent = 'Importando...'

  const { data, error } = await db.rpc('importar_precos', {
    p_fornecedor_id: fornecedorId,
    p_arquivo_nome: arquivoNome,
    p_itens: itens,
    p_qtd_rejeitados: rejeitadas.length,
    p_relatorio: rejeitadas.length ? rejeitadas : null
  })

  btn.disabled = false
  btn.textContent = 'Confirmar importação'

  document.getElementById('imp-passo2').classList.add('oculta')
  document.getElementById('imp-passo3').classList.remove('oculta')
  if (error) {
    document.getElementById('imp-resultado').innerHTML = `
      <div class="resumo-imp"><div class="resumo-item erro"><div class="num">✕</div><div class="rotulo">Falhou</div></div></div>
      <p>A importação foi desfeita por completo — nenhum registro foi alterado.</p>
      <p class="dica">${esc(error.message)}</p>`
    return
  }
  document.getElementById('imp-resultado').innerHTML = `
    <div class="resumo-imp">
      <div class="resumo-item ok"><div class="num">${data.criados}</div><div class="rotulo">criados</div></div>
      <div class="resumo-item"><div class="num">${data.atualizados}</div><div class="rotulo">atualizados</div></div>
      <div class="resumo-item"><div class="num">${data.inalterados}</div><div class="rotulo">sem mudança</div></div>
      <div class="resumo-item ${data.rejeitados ? 'alerta' : ''}"><div class="num">${data.rejeitados}</div><div class="rotulo">rejeitados</div></div>
    </div>`
  importacaoPendente = null
  indiceMedidas = null
  buscarProdutos(document.getElementById('busca-medida').value)
})

// ─── Clientes: validação de CPF/CNPJ (RF02) ───────────────────────────────────

function validaCPF(doc) {
  if (doc.length !== 11 || /^(\d)\1+$/.test(doc)) return false
  for (const t of [9, 10]) {
    let soma = 0
    for (let i = 0; i < t; i++) soma += Number(doc[i]) * (t + 1 - i)
    const dv = ((soma * 10) % 11) % 10
    if (dv !== Number(doc[t])) return false
  }
  return true
}

function validaCNPJ(doc) {
  if (doc.length !== 14 || /^(\d)\1+$/.test(doc)) return false
  const calc = t => {
    const pesos = t === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2]
    let soma = 0
    for (let i = 0; i < t; i++) soma += Number(doc[i]) * pesos[i]
    const resto = soma % 11
    return resto < 2 ? 0 : 11 - resto
  }
  return calc(12) === Number(doc[12]) && calc(13) === Number(doc[13])
}

function fmtDocumento(doc) {
  if (!doc) return '—'
  if (doc.length === 11) return doc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
  if (doc.length === 14) return doc.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')
  return doc
}

// ─── Camada única de consulta por documento (R2, R3, R4) ─────────────────────
// Ponto único de acesso à base de consulta. O cadastro (R3) e o cabeçalho do
// pedido (R4) chamam esta função — nenhum dos dois conhece a origem do dado.
// Hoje a origem é a própria tabela `cliente` (a base de 48.891 registros já
// importada); quando ela for separada numa tabela `base_consulta` somente
// leitura, muda só o corpo de `buscarNaBase` — os chamadores seguem iguais.

const CONSULTA = {
  ENCONTRADO: 'ENCONTRADO',
  FORA_DA_BASE: 'FORA_DA_BASE',
  INCOMPLETO: 'INCOMPLETO',
  DOCUMENTO_INVALIDO: 'DOCUMENTO_INVALIDO',
  ERRO: 'ERRO',
  TIMEOUT: 'TIMEOUT'
}

const CONSULTA_TIMEOUT_MS = 8000

// Só dígitos — aceita o documento digitado com ou sem máscara.
function normalizarDocumento(entrada) {
  return String(entrada ?? '').replace(/\D/g, '')
}

function tipoDocumento(digitos) {
  if (digitos.length === 11) return 'PF'
  if (digitos.length === 14) return 'PJ'
  return null
}

// Para mensagem e log: nunca expõe o documento inteiro em texto puro.
function mascararDocumento(digitos) {
  const d = normalizarDocumento(digitos)
  if (d.length < 5) return '***'
  return `${d.slice(0, 3)}${'*'.repeat(d.length - 5)}${d.slice(-2)}`
}

function documentoValido(digitos) {
  const tipo = tipoDocumento(digitos)
  if (tipo === 'PF') return validaCPF(digitos)
  if (tipo === 'PJ') return validaCNPJ(digitos)
  return false
}

// Acesso à origem do dado. Isolado de propósito (ADR-03).
function buscarNaBase(digitos) {
  return db.from('cliente')
    .select('*')
    .eq('documento', digitos)
    .limit(1)
}

// Devolve sempre um objeto de estado — nunca lança.
async function consultarPorDocumento(entrada, opcoes) {
  const timeoutMs = (opcoes && opcoes.timeoutMs) || CONSULTA_TIMEOUT_MS
  const documento = normalizarDocumento(entrada)
  const tipo = tipoDocumento(documento)

  // Validação ANTES de consultar: não gasta chamada nem trafega lixo.
  if (documento.length !== 11 && documento.length !== 14) {
    return {
      estado: CONSULTA.INCOMPLETO, documento, tipo: null, dados: null,
      mensagem: 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).'
    }
  }
  if (!documentoValido(documento)) {
    return {
      estado: CONSULTA.DOCUMENTO_INVALIDO, documento, tipo, dados: null,
      mensagem: `${tipo === 'PJ' ? 'CNPJ' : 'CPF'} inválido — confira os dígitos.`
    }
  }

  let expirou
  const relogio = new Promise(resolve => {
    expirou = setTimeout(() => resolve({ __timeout: true }), timeoutMs)
  })

  try {
    const resposta = await Promise.race([buscarNaBase(documento), relogio])
    if (resposta && resposta.__timeout) {
      return {
        estado: CONSULTA.TIMEOUT, documento, tipo, dados: null,
        mensagem: 'A consulta demorou demais. Verifique a conexão e tente de novo.'
      }
    }
    if (resposta && resposta.error) {
      // Diagnóstico sem vazar dado pessoal: o documento vai mascarado.
      console.warn('Falha ao consultar a base', mascararDocumento(documento), resposta.error.code || '')
      return {
        estado: CONSULTA.ERRO, documento, tipo, dados: null,
        mensagem: 'Não foi possível consultar a base agora. Tente de novo em instantes.'
      }
    }
    const achado = (resposta && resposta.data && resposta.data[0]) || null
    if (!achado) {
      return {
        estado: CONSULTA.FORA_DA_BASE, documento, tipo, dados: null,
        mensagem: `Cliente fora da base — preencha os dados para cadastrar.`
      }
    }
    return {
      estado: CONSULTA.ENCONTRADO, documento, tipo, dados: achado,
      mensagem: `Cliente encontrado na base.`
    }
  } catch {
    console.warn('Erro de rede ao consultar a base', mascararDocumento(documento))
    return {
      estado: CONSULTA.ERRO, documento, tipo, dados: null,
      mensagem: 'Falha de rede ao consultar a base. Tente de novo.'
    }
  } finally {
    clearTimeout(expirou)
  }
}

// ─── Clientes: busca e listagem (RF05) ────────────────────────────────────────

let clientesCache = {}

function dataISO(diasAtras) {
  const d = new Date(Date.now() - diasAtras * 86400000)
  return d.toISOString().slice(0, 10)
}

function aplicarFiltrosClientes(query) {
  const tipo = document.getElementById('fil-tipo').value
  const canal = document.getElementById('fil-canal').value
  const atividade = document.getElementById('fil-atividade').value
  const uf = document.getElementById('fil-uf').value
  const status = document.getElementById('fil-status').value
  const beneficio = document.getElementById('fil-beneficio').value
  if (tipo) query = query.eq('tipo', tipo)
  if (canal) query = query.like('segmento', `${canal}|%`)
  if (atividade) query = query.ilike('segmento', `%${atividade}%`)
  if (uf) query = query.eq('uf', uf)
  if (beneficio === 'com') query = query.not('beneficio_fiscal', 'is', null)
  else if (beneficio === 'sem') query = query.is('beneficio_fiscal', null)
  else if (beneficio) query = query.eq('beneficio_fiscal', beneficio)
  if (status === 'ativo') query = query.gte('ultima_compra', dataISO(90))
  if (status === 'esfriando') query = query.gte('ultima_compra', dataISO(365)).lt('ultima_compra', dataISO(90))
  if (status === 'inativo') query = query.lt('ultima_compra', dataISO(365))
  if (status === 'nunca') query = query.is('ultima_compra', null)
  return query
}

async function buscarClientes(termo) {
  const el = document.getElementById('resultado-clientes')
  const t = (termo ?? document.getElementById('busca-cliente').value ?? '').trim()
  if (t && t.length < 3) { el.innerHTML = '<div class="vazio">Digite ao menos 3 caracteres.</div>'; return }

  const ordem = document.getElementById('fil-ordem').value
  let query = db.from('cliente').select('*', { count: 'exact' }).limit(50)
  query = ordem === 'nome'
    ? query.order('nome')
    : query.order(ordem, { ascending: false, nullsFirst: false }).order('nome')

  if (t) {
    const digitos = t.replace(/\D/g, '')
    const filtros = [`nome.ilike.*${t}*`]
    if (digitos.length >= 3) {
      filtros.push(`documento.like.${digitos}*`)
      filtros.push(`telefone.ilike.*${t}*`, `celular.ilike.*${t}*`)
    }
    query = query.or(filtros.join(','))
  }
  query = aplicarFiltrosClientes(query)

  const { data, count, error } = await query
  if (error) { el.innerHTML = '<div class="vazio">Erro ao consultar clientes.</div>'; return }
  document.getElementById('clientes-contagem').textContent =
    count ? `${count.toLocaleString('pt-BR')} cliente${count > 1 ? 's' : ''} encontrado${count > 1 ? 's' : ''}${count > 50 ? ' — mostrando os 50 primeiros' : ''}` : ''
  renderClientes(data || [], t)
}

function linkWhatsApp(c) {
  const d = (c.celular || '').replace(/\D/g, '')
  if (d.length < 10) return ''
  return `<a class="btn whats" href="https://wa.me/55${d}" target="_blank" onclick="event.stopPropagation()">WhatsApp</a>`
}

function atividadeCurta(segmento) {
  const a = (segmento || '').split('|')[1] || ''
  return a.trim().replace(' (CPF)', '').replace(' (CNPJ)', '')
}

function diasSemComprar(c) {
  if (!c.ultima_compra) return null
  return Math.floor((Date.now() - new Date(c.ultima_compra + 'T12:00:00').getTime()) / 86400000)
}

function badgeCompra(c) {
  const dias = diasSemComprar(c)
  if (dias === null) return '<span class="suave">nunca comprou</span>'
  const cls = dias <= 90 ? 'entregue' : dias <= 365 ? 'orcamento' : 'cancelado'
  return `${fmtData(c.ultima_compra + 'T12:00:00')}<br><span class="badge ${cls}">há ${dias} dias</span>`
}

function renderClientes(clientes, termo) {
  const el = document.getElementById('resultado-clientes')
  clientesCache = {}
  if (!clientes.length) {
    el.innerHTML = `<div class="vazio">Nenhum cliente encontrado${termo ? ` para "${esc(termo)}"` : ' com esses filtros'}.<br><br>
      <button class="btn primario" onclick="document.getElementById('btn-novo-cliente').click()">+ Cadastrar novo cliente</button></div>`
    return
  }
  el.innerHTML = `<div class="tabela-scroll"><table>
    <tr><th>Nome</th><th>Atividade</th><th>Cidade</th><th>Contato</th><th>Última compra</th><th>Compras</th><th>Frota</th></tr>
    ${clientes.map(c => {
      clientesCache[c.id] = c
      return `<tr class="linha-clicavel" onclick="abrirFicha(${c.id})">
        <td><strong>${esc(c.nome)}</strong> <span class="badge ${c.tipo.toLowerCase()}">${c.tipo}</span>
            ${c.beneficio_fiscal ? `<span class="badge beneficio" title="Cliente com benefício fiscal">★ ${esc(c.beneficio_fiscal)}</span>` : ''}
            ${c.ativo ? '' : '<span class="badge inativo">Inativo</span>'}<br>
            <span class="suave">${fmtDocumento(c.documento)}</span></td>
        <td class="suave">${esc(atividadeCurta(c.segmento) || '—')}</td>
        <td>${esc([c.cidade, c.uf].filter(Boolean).join(' / ') || '—')}</td>
        <td>${esc(c.celular || c.telefone || '—')}<br>${linkWhatsApp(c)}</td>
        <td>${badgeCompra(c)}</td>
        <td>${c.qtd_compras ?? '—'}</td>
        <td>${c.qtd_veiculos || '—'}</td>
      </tr>`
    }).join('')}
  </table></div>`
}

let buscaCliTimer
document.getElementById('busca-cliente').addEventListener('input', e => {
  clearTimeout(buscaCliTimer)
  buscaCliTimer = setTimeout(() => buscarClientes(e.target.value), 300)
})
;['fil-tipo', 'fil-canal', 'fil-atividade', 'fil-uf', 'fil-beneficio', 'fil-status', 'fil-ordem'].forEach(id =>
  document.getElementById(id).addEventListener('change', () => buscarClientes()))

// 🎯 Sugestões: bons compradores parados há mais de 90 dias, os maiores primeiro
document.getElementById('btn-sugestoes').addEventListener('click', () => {
  document.getElementById('busca-cliente').value = ''
  document.getElementById('fil-status').value = 'esfriando'
  document.getElementById('fil-ordem').value = 'qtd_compras'
  marcarRadar('esfriando')
  buscarClientes('')
  toast('Bons compradores parados há 91–365 dias, maiores primeiro — hora de ligar!')
})

// ─── Radar da carteira ────────────────────────────────────────────────────────

let radarCarregado = false

async function carregarRadar() {
  if (radarCarregado) return
  radarCarregado = true
  const base = () => db.from('cliente').select('id', { count: 'exact', head: true }).eq('ativo', true)
  const [a, e, i, n] = await Promise.all([
    base().gte('ultima_compra', dataISO(90)),
    base().gte('ultima_compra', dataISO(365)).lt('ultima_compra', dataISO(90)),
    base().lt('ultima_compra', dataISO(365)),
    base().is('ultima_compra', null)
  ])
  const card = (cls, rotulo, count, titulo) =>
    `<div class="radar-card ${cls}" data-status="${cls}" title="${titulo}" onclick="filtrarRadar('${cls}')">
      <div class="num">${(count || 0).toLocaleString('pt-BR')}</div><div class="rotulo">${rotulo}</div></div>`
  document.getElementById('radar-clientes').innerHTML =
    card('ativo', 'Ativos', a.count, 'Compraram nos últimos 90 dias') +
    card('esfriando', 'Esfriando', e.count, 'Compraram entre 91 e 365 dias atrás — priorize estes!') +
    card('inativo', 'Parados +1 ano', i.count, 'Última compra há mais de 1 ano') +
    card('nunca', 'Nunca compraram', n.count, 'Cadastrados sem nenhuma compra')
}

function marcarRadar(status) {
  document.querySelectorAll('.radar-card').forEach(c =>
    c.classList.toggle('selecionado', c.dataset.status === status))
}

window.filtrarRadar = status => {
  const sel = document.getElementById('fil-status')
  const jaAtivo = sel.value === status
  sel.value = jaAtivo ? '' : status
  marcarRadar(jaAtivo ? '' : status)
  buscarClientes()
}

// UFs no filtro
document.getElementById('fil-uf').innerHTML = '<option value="">UF: todas</option>' +
  'AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO'
    .split(' ').map(u => `<option>${u}</option>`).join('')

// ─── Clientes: ficha com histórico (RF08) ─────────────────────────────────────

window.abrirFicha = async id => {
  const c = clientesCache[id]
  if (!c) return
  const modal = document.getElementById('modal-ficha')
  const campo = (rotulo, valor) => `<div class="campo"><span class="rotulo">${rotulo}</span><span>${esc(valor || '—')}</span></div>`
  const flags = c.tipo === 'PJ'
    ? [['Consumidor final', c.consumidor_final], ['Revenda', c.revenda], ['Indústria', c.industria], ['Simples Nacional', c.simples_nacional]]
        .map(([r, v]) => campo(r, v === null ? null : (v ? 'Sim' : 'Não'))).join('')
    : ''

  document.getElementById('ficha-conteudo').innerHTML = `
    <div class="ficha-topo">
      <div>
        <h2>${esc(c.nome)} <span class="badge ${c.tipo.toLowerCase()}">${c.tipo}</span>
        ${c.beneficio_fiscal ? `<span class="badge beneficio">★ Benefício: ${esc(c.beneficio_fiscal)}</span>` : ''}
        ${c.ativo ? '' : '<span class="badge inativo">Inativo</span>'}</h2>
        <span class="suave">${fmtDocumento(c.documento)}</span>
      </div>
      <div class="acoes">
        ${linkWhatsApp(c)}
        ${c.ativo ? `<button class="btn mini primario" onclick="novoPedidoDoCliente(${c.id})">+ Novo pedido</button>` : ''}
        <button class="btn mini" onclick="editarCliente(${c.id})">Editar</button>
        <button class="btn mini" onclick="toggleCliente(${c.id}, ${!c.ativo})">${c.ativo ? 'Inativar' : 'Reativar'}</button>
      </div>
    </div>
    <div class="ficha-secao">Contato e endereço</div>
    <div class="ficha-dados">
      ${campo('Telefone', c.telefone)}
      ${campo('Celular', c.celular)}
      ${campo('E-mail', c.email)}
      ${campo('CEP', c.cep)}
      ${campo('Endereço', [c.logradouro, c.numero].filter(Boolean).join(', '))}
      ${campo('Complemento', c.complemento)}
      ${campo('Bairro', c.bairro)}
      ${campo('Cidade / UF', [c.cidade, c.uf].filter(Boolean).join(' / '))}
    </div>
    ${c.tipo === 'PJ' ? `
      <div class="ficha-secao">Dados da empresa</div>
      <div class="ficha-dados">
        ${campo('Nome fantasia', c.nome_fantasia)}
        ${campo('Data de abertura', c.data_abertura ? fmtData(c.data_abertura + 'T12:00:00') : null)}
        ${campo('Inscrição estadual', c.inscricao_estadual)}
        ${campo('Inscrição municipal', c.inscricao_municipal)}
        ${flags}
        ${campo('Referências comerciais', c.referencias_comerciais)}
        ${campo('Parecer do vendedor', c.parecer_vendedor)}
      </div>` : `
      <div class="ficha-secao">Dados pessoais</div>
      <div class="ficha-dados">
        ${campo('Data de nascimento', c.data_nascimento ? fmtData(c.data_nascimento + 'T12:00:00') : null)}
        ${campo('País', c.pais)}
      </div>`}
    <div class="ficha-secao">Comercial</div>
    <div class="ficha-dados">
      ${campo('Benefício fiscal', c.beneficio_fiscal)}
      ${campo('Vendedor responsável', c.vendedor_nome)}
      ${campo('Segmento', c.segmento)}
      ${campo('Categoria', c.categoria)}
      ${campo('Cliente desde', c.criado_em ? fmtData(c.criado_em) : null)}
      ${campo('Compras acumuladas', c.qtd_compras != null ? String(c.qtd_compras) : null)}
      ${campo('Primeira compra', c.primeira_compra ? fmtData(c.primeira_compra + 'T12:00:00') : null)}
      ${campo('Última compra', c.ultima_compra ? `${fmtData(c.ultima_compra + 'T12:00:00')} (há ${diasSemComprar(c)} dias)` : 'Nunca comprou')}
      ${campo('Frota (veículos)', c.qtd_veiculos ? String(c.qtd_veiculos) : null)}
      ${campo('Limite de crédito', c.limite_credito ? fmtReal(c.limite_credito) : null)}
      ${campo('Observações', c.observacao)}
    </div>
    <div class="ficha-secao">Histórico de pedidos</div>
    <div id="ficha-pedidos"><div class="vazio">Carregando...</div></div>
    <div class="modal-acoes"><button class="btn" onclick="document.getElementById('modal-ficha').classList.add('oculta')">Fechar</button></div>`
  modal.classList.remove('oculta')

  const { data: pedidos } = await db.from('pedido')
    .select('numero, emitido_em, total_liquido, situacao')
    .eq('cliente_id', c.id).order('emitido_em', { ascending: false }).limit(30)
  document.getElementById('ficha-pedidos').innerHTML = (pedidos && pedidos.length)
    ? `<div class="tabela-scroll"><table>
        <tr><th>Nº</th><th>Data</th><th>Total</th><th>Situação</th></tr>
        ${pedidos.map(p => `<tr><td>${p.numero}</td><td>${fmtData(p.emitido_em)}</td>
          <td class="preco">${fmtReal(p.total_liquido)}</td><td>${esc(p.situacao)}</td></tr>`).join('')}
      </table></div>`
    : '<div class="vazio">Nenhum pedido registrado.</div>'
}

window.toggleCliente = async (id, ativo) => {
  const { error } = await db.from('cliente').update({ ativo }).eq('id', id)
  if (error) return toast('Erro ao alterar cliente', true)
  toast(ativo ? 'Cliente reativado' : 'Cliente inativado (histórico preservado)')
  document.getElementById('modal-ficha').classList.add('oculta')
  buscarClientes(document.getElementById('busca-cliente').value)
}

// ─── Clientes: cadastro e edição (RF01–RF04, fichas cadastrais PF/PJ) ─────────

function aplicarTipoCliente(tipo) {
  document.querySelectorAll('.so-pf').forEach(el => el.classList.toggle('oculta', tipo !== 'PF'))
  document.querySelectorAll('.so-pj').forEach(el => el.classList.toggle('oculta', tipo !== 'PJ'))
  document.getElementById('rotulo-nome').firstChild.textContent = tipo === 'PJ' ? 'Razão social' : 'Nome completo'
  document.getElementById('rotulo-doc').firstChild.textContent = tipo === 'PJ' ? 'CNPJ' : 'CPF'
}

document.querySelectorAll('input[name="cli-tipo"]').forEach(r =>
  r.addEventListener('change', () => aplicarTipoCliente(r.value)))

// Abre o cadastro em branco. `documento` opcional: vem do cabeçalho do pedido
// quando o representante consultou um CNPJ que não está na base (R4).
function abrirCadastroNovo(documento) {
  document.getElementById('modal-cliente-titulo').textContent = 'Novo cliente'
  document.getElementById('form-cliente').reset()
  document.getElementById('cli-id').value = ''
  ultimoDocConsultado = null
  const tipo = tipoDocumento(normalizarDocumento(documento || '')) || 'PF'
  document.querySelector(`input[name="cli-tipo"][value="${tipo}"]`).checked = true
  aplicarTipoCliente(tipo)
  mostrarStatusConsulta(null)
  document.getElementById('modal-cliente').classList.remove('oculta')
  if (documento) {
    document.getElementById('cli-documento').value = fmtDocumento(normalizarDocumento(documento))
    consultarDocumentoCadastro()
  } else {
    document.getElementById('cli-documento').focus()
  }
}

document.getElementById('btn-novo-cliente').addEventListener('click', () => abrirCadastroNovo())

// Preenche o formulário a partir de um registro. Usado tanto pela edição
// quanto pelo autopreenchimento da consulta por documento (R3) — ponto único.
function preencherFormCliente(c) {
  const tipo = c.tipo || tipoDocumento(normalizarDocumento(c.documento)) || 'PF'
  const radio = document.querySelector(`input[name="cli-tipo"][value="${tipo}"]`)
  if (radio) radio.checked = true
  aplicarTipoCliente(tipo)
  const set = (idc, v) => { document.getElementById(idc).value = v || '' }
  set('cli-nome', c.nome); set('cli-fantasia', c.nome_fantasia)
  set('cli-documento', fmtDocumento(c.documento))
  set('cli-nascimento', c.data_nascimento); set('cli-abertura', c.data_abertura)
  set('cli-ie', c.inscricao_estadual); set('cli-im', c.inscricao_municipal)
  set('cli-telefone', c.telefone); set('cli-celular', c.celular); set('cli-email', c.email)
  set('cli-cep', c.cep); set('cli-logradouro', c.logradouro); set('cli-numero', c.numero)
  set('cli-complemento', c.complemento); set('cli-bairro', c.bairro)
  set('cli-cidade', c.cidade); set('cli-uf', c.uf); set('cli-pais', c.pais || 'Brasil')
  set('cli-beneficio', c.beneficio_fiscal)
  set('cli-vendedor', c.vendedor_nome); set('cli-referencias', c.referencias_comerciais)
  set('cli-parecer', c.parecer_vendedor); set('cli-observacao', c.observacao)
  document.getElementById('cli-consumidor-final').checked = !!c.consumidor_final
  document.getElementById('cli-revenda').checked = !!c.revenda
  document.getElementById('cli-industria').checked = !!c.industria
  document.getElementById('cli-simples').checked = !!c.simples_nacional
}

window.editarCliente = id => {
  const c = clientesCache[id]
  if (!c) return
  document.getElementById('modal-ficha').classList.add('oculta')
  document.getElementById('modal-cliente-titulo').textContent = 'Editar cliente'
  document.getElementById('form-cliente').reset()
  document.getElementById('cli-id').value = c.id
  ultimoDocConsultado = null
  preencherFormCliente(c)
  mostrarStatusConsulta(null)
  document.getElementById('modal-cliente').classList.remove('oculta')
}

document.getElementById('btn-cancelar-cliente').addEventListener('click', () => {
  document.getElementById('modal-cliente').classList.add('oculta')
})

// ─── R3: autopreenchimento do cadastro pela consulta por documento ────────────

// Mostra o resultado da consulta acima dos campos. `null` limpa a área.
function mostrarStatusConsulta(resultado) {
  const el = document.getElementById('cli-consulta-status')
  if (!el) return
  if (!resultado) { el.className = 'consulta-status oculta'; el.textContent = ''; return }
  const classe = {
    ENCONTRADO: 'ok',
    FORA_DA_BASE: 'aviso',
    DOCUMENTO_INVALIDO: 'erro',
    INCOMPLETO: 'neutro',
    ERRO: 'erro',
    TIMEOUT: 'erro'
  }[resultado.estado] || 'neutro'
  el.className = `consulta-status ${classe}`
  el.textContent = resultado.mensagem
}

// Último documento já resolvido, para não consultar duas vezes o mesmo.
// Necessário porque mover o foco para outro campo dispara um segundo `blur`.
// Só guarda resultado assentado: erro e timeout continuam permitindo repetir.
let ultimoDocConsultado = null

// Consulta disparada ao terminar de digitar o documento no cadastro.
async function consultarDocumentoCadastro() {
  const campo = document.getElementById('cli-documento')
  const digitos = normalizarDocumento(campo.value)
  const editando = !!document.getElementById('cli-id').value

  // Documento ainda incompleto: não polui a tela com erro enquanto digita.
  if (digitos.length !== 11 && digitos.length !== 14) { mostrarStatusConsulta(null); return }
  // Em edição o documento é o do próprio registro — não reconsulta.
  if (editando) return
  if (digitos === ultimoDocConsultado) return

  mostrarStatusConsulta({ estado: 'INCOMPLETO', mensagem: 'Consultando a base...' })
  const r = await consultarPorDocumento(digitos)
  mostrarStatusConsulta(r)
  if (r.estado === CONSULTA.ENCONTRADO || r.estado === CONSULTA.FORA_DA_BASE) {
    ultimoDocConsultado = digitos
  }

  if (r.estado === CONSULTA.ENCONTRADO) {
    // O registro achado é o próprio cadastro: preenche e passa a editar,
    // em vez de deixar o usuário esbarrar na violação de documento único.
    preencherFormCliente(r.dados)
    document.getElementById('cli-id').value = r.dados.id
    document.getElementById('modal-cliente-titulo').textContent = 'Cliente já cadastrado — confira os dados'
    mostrarStatusConsulta({
      estado: 'ENCONTRADO',
      mensagem: 'Cliente encontrado na base — dados preenchidos. Confira e salve.'
    })
  } else if (r.estado === CONSULTA.FORA_DA_BASE) {
    // Fora da base: mantém o que foi digitado e libera o preenchimento manual.
    const tipo = tipoDocumento(digitos)
    const radio = document.querySelector(`input[name="cli-tipo"][value="${tipo}"]`)
    if (radio) { radio.checked = true; aplicarTipoCliente(tipo) }
    document.getElementById('cli-nome').focus()
  }
}

document.getElementById('cli-documento').addEventListener('blur', consultarDocumentoCadastro)
document.getElementById('cli-documento').addEventListener('change', consultarDocumentoCadastro)

document.getElementById('form-cliente').addEventListener('submit', async e => {
  e.preventDefault()
  const id = document.getElementById('cli-id').value
  const tipo = document.querySelector('input[name="cli-tipo"]:checked').value
  const doc = document.getElementById('cli-documento').value.replace(/\D/g, '')

  if (tipo === 'PF' && !validaCPF(doc)) return toast('CPF inválido — confira os dígitos', true)
  if (tipo === 'PJ' && !validaCNPJ(doc)) return toast('CNPJ inválido — confira os dígitos', true)

  const v = idc => document.getElementById(idc).value.trim() || null
  const registro = {
    tipo, documento: doc,
    nome: v('cli-nome'),
    nome_fantasia: tipo === 'PJ' ? v('cli-fantasia') : null,
    data_nascimento: tipo === 'PF' ? v('cli-nascimento') : null,
    data_abertura: tipo === 'PJ' ? v('cli-abertura') : null,
    inscricao_estadual: tipo === 'PJ' ? v('cli-ie') : null,
    inscricao_municipal: tipo === 'PJ' ? v('cli-im') : null,
    telefone: formatTelefone(v('cli-telefone')) || null,
    celular: formatTelefone(v('cli-celular')) || null,
    email: v('cli-email'),
    cep: v('cli-cep'), logradouro: v('cli-logradouro'), numero: v('cli-numero'),
    complemento: v('cli-complemento'), bairro: v('cli-bairro'),
    cidade: v('cli-cidade'), uf: (v('cli-uf') || '').toUpperCase() || null,
    pais: tipo === 'PF' ? v('cli-pais') : null,
    consumidor_final: tipo === 'PJ' ? document.getElementById('cli-consumidor-final').checked : null,
    revenda: tipo === 'PJ' ? document.getElementById('cli-revenda').checked : null,
    industria: tipo === 'PJ' ? document.getElementById('cli-industria').checked : null,
    simples_nacional: tipo === 'PJ' ? document.getElementById('cli-simples').checked : null,
    beneficio_fiscal: v('cli-beneficio'),
    vendedor_nome: v('cli-vendedor'),
    referencias_comerciais: tipo === 'PJ' ? v('cli-referencias') : null,
    parecer_vendedor: tipo === 'PJ' ? v('cli-parecer') : null,
    observacao: v('cli-observacao')
  }

  const { error } = id
    ? await db.from('cliente').update(registro).eq('id', id)
    : await db.from('cliente').insert(registro)
  if (error) {
    if (error.code === '23505') return toast(`Já existe cliente com esse ${tipo === 'PJ' ? 'CNPJ' : 'CPF'} — busque pelo documento para abrir o cadastro`, true)
    return toast('Erro ao gravar cliente', true)
  }
  toast(id ? 'Cliente atualizado' : 'Cliente cadastrado')
  document.getElementById('modal-cliente').classList.add('oculta')
  buscarClientes(document.getElementById('busca-cliente').value || doc)
  if (!id) document.getElementById('busca-cliente').value = doc
})

// Telefone BR: (DD) 9XXXX-XXXX / (DD) XXXX-XXXX
function formatTelefone(vl) {
  let d = (vl || '').replace(/\D/g, '').replace(/^0+/, '')
  if (d.length >= 11) d = d.slice(0, 11)
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return (vl || '').trim()
}

// ─── Pedidos: lista e filtros (RF35) ──────────────────────────────────────────

const SITUACAO_ROTULO = { ORCAMENTO: 'Orçamento', CONFIRMADO: 'Confirmado', ENTREGUE: 'Entregue', CANCELADO: 'Cancelado' }

async function buscarPedidos() {
  const el = document.getElementById('resultado-pedidos')
  const nome = document.getElementById('ped-busca-cliente').value.trim()
  const situacao = document.getElementById('ped-filtro-situacao').value
  const de = document.getElementById('ped-filtro-de').value
  const ate = document.getElementById('ped-filtro-ate').value

  const tipoCliente = document.getElementById('ped-filtro-tipo').value
  let query = db.from('pedido')
    .select('*, cliente!inner(nome, tipo)')
    .order('emitido_em', { ascending: false })
    .limit(50)
  if (nome) query = query.ilike('cliente.nome', `%${nome}%`)
  if (tipoCliente) query = query.eq('cliente.tipo', tipoCliente)
  if (situacao) query = query.eq('situacao', situacao)
  if (de) query = query.gte('emitido_em', de)
  if (ate) query = query.lte('emitido_em', ate + 'T23:59:59')

  const { data, error } = await query
  if (error) { el.innerHTML = '<div class="vazio">Erro ao consultar pedidos.</div>'; return }
  if (!data.length) { el.innerHTML = '<div class="vazio">Nenhum pedido encontrado. Clique em "+ Novo pedido" para emitir um orçamento.</div>'; return }
  el.innerHTML = `<div class="tabela-scroll"><table>
    <tr><th>Nº</th><th>Data</th><th>Cliente</th><th>Total</th><th>Validade</th><th>Situação</th></tr>
    ${data.map(p => `<tr class="linha-clicavel" onclick="abrirPedido(${p.id})">
      <td><strong>#${p.numero}</strong></td>
      <td>${fmtData(p.emitido_em)}</td>
      <td>${esc(p.cliente?.nome || '—')}</td>
      <td class="preco">${fmtReal(p.total_liquido)}</td>
      <td class="suave">${p.validade_em ? fmtData(p.validade_em + 'T12:00:00') : '—'}</td>
      <td><span class="badge ${p.situacao.toLowerCase()}">${SITUACAO_ROTULO[p.situacao]}</span></td>
    </tr>`).join('')}
  </table></div>`
}

;['ped-filtro-tipo', 'ped-filtro-situacao', 'ped-filtro-de', 'ped-filtro-ate'].forEach(id =>
  document.getElementById(id).addEventListener('change', buscarPedidos))
let buscaPedTimer
document.getElementById('ped-busca-cliente').addEventListener('input', () => {
  clearTimeout(buscaPedTimer)
  buscaPedTimer = setTimeout(buscarPedidos, 300)
})

// ─── Pedidos: editor (RF25–RF33, RN03, RN05, RN07) ────────────────────────────

let pedidoAtual = null

function novoPedido(cliente) {
  pedidoAtual = { id: null, situacao: 'ORCAMENTO', cliente: cliente || null, itens: [],
                  desconto_valor: 0, forma_pagto: '', observacao: '' }
  document.getElementById('ped-desconto').value = ''
  document.getElementById('ped-desconto-tipo').value = 'R$'
  document.getElementById('ped-forma-pagto').value = ''
  document.getElementById('ped-observacao').value = ''
  document.getElementById('ped-cliente-input').value = ''
  document.getElementById('ped-produto-input').value = ''
  document.getElementById('editor-movimentos').innerHTML = ''
  abrirEditor()
}

document.getElementById('btn-novo-pedido').addEventListener('click', () => novoPedido(null))
document.getElementById('btn-voltar-pedidos').addEventListener('click', () => {
  document.getElementById('pedido-editor').classList.add('oculta')
  document.getElementById('pedidos-lista').classList.remove('oculta')
  buscarPedidos()
})

function abrirEditor() {
  document.getElementById('pedidos-lista').classList.add('oculta')
  document.getElementById('pedido-editor').classList.remove('oculta')
  const p = pedidoAtual
  const editavel = p.situacao === 'ORCAMENTO'
  document.getElementById('editor-titulo').innerHTML = p.id
    ? `Pedido #${p.numero} <span class="badge ${p.situacao.toLowerCase()}">${SITUACAO_ROTULO[p.situacao]}</span>`
    : 'Novo orçamento'
  renderSituacaoAcoes()
  renderClienteEscolhido()
  renderItens()
  renderTotais()
  document.getElementById('editor-produto-busca').classList.toggle('oculta', !editavel)
  document.getElementById('btn-salvar-pedido').classList.toggle('oculta', !editavel)
  ;['ped-desconto', 'ped-desconto-tipo', 'ped-forma-pagto', 'ped-observacao'].forEach(id =>
    document.getElementById(id).disabled = !editavel)
}

function renderSituacaoAcoes() {
  const el = document.getElementById('editor-situacao-acoes')
  const p = pedidoAtual
  if (!p.id) { el.innerHTML = ''; return }
  const transicoes = { ORCAMENTO: ['CONFIRMADO', 'CANCELADO'], CONFIRMADO: ['ENTREGUE', 'CANCELADO'] }[p.situacao] || []
  el.innerHTML = transicoes.map(t =>
    `<button class="btn mini ${t === 'CANCELADO' ? '' : 'primario'}" onclick="transicionar(${p.id}, '${t}')">
      ${t === 'CONFIRMADO' ? 'Confirmar pedido' : t === 'ENTREGUE' ? 'Marcar entregue' : 'Cancelar'}</button>`).join('')
}

window.transicionar = async (id, para) => {
  let motivo = null
  if (para === 'CANCELADO') {
    motivo = prompt('Motivo do cancelamento (obrigatório):')
    if (!motivo || !motivo.trim()) return toast('O cancelamento exige motivo', true)
  }
  const { error } = await db.rpc('mudar_situacao', { p_pedido_id: id, p_para: para, p_motivo: motivo })
  if (error) return toast(error.message, true)
  toast(`Pedido ${SITUACAO_ROTULO[para].toLowerCase()}`)
  abrirPedido(id)
}

function renderClienteEscolhido() {
  const escolhido = document.getElementById('editor-cliente-escolhido')
  const busca = document.getElementById('editor-cliente-busca')
  const p = pedidoAtual
  const editavel = p.situacao === 'ORCAMENTO'
  const aviso = document.getElementById('editor-cliente-aviso')
  aviso.innerHTML = (p.cliente && p.cliente.beneficio_fiscal)
    ? `<div class="aviso-beneficio">★ Atenção: cliente com benefício fiscal (${esc(p.cliente.beneficio_fiscal)}) — confira preço e tributação antes de fechar.</div>`
    : ''
  if (p.cliente) {
    escolhido.classList.remove('oculta')
    busca.classList.add('oculta')
    escolhido.innerHTML = `<span><strong>${esc(p.cliente.nome)}</strong>
      <span class="suave">${fmtDocumento(p.cliente.documento)}</span></span>
      ${editavel ? '<button class="btn mini" onclick="trocarClientePedido()">Trocar</button>' : ''}`
  } else {
    escolhido.classList.add('oculta')
    busca.classList.remove('oculta')
  }
}

window.trocarClientePedido = () => {
  pedidoAtual.cliente = null
  renderClienteEscolhido()
  document.getElementById('ped-cliente-input').focus()
}

// ─── R4: identificar o cliente do pedido pelo documento ──────────────────────
// Usa exatamente a mesma camada do cadastro (consultarPorDocumento) — a busca
// por nome logo abaixo continua existindo para quem não tem o documento à mão.

function mostrarStatusPedido(resultado, documento) {
  const el = document.getElementById('ped-consulta-status')
  if (!el) return
  if (!resultado) { el.className = 'consulta-status oculta'; el.innerHTML = ''; return }
  const classe = {
    ENCONTRADO: 'ok', FORA_DA_BASE: 'aviso', DOCUMENTO_INVALIDO: 'erro',
    INCOMPLETO: 'neutro', ERRO: 'erro', TIMEOUT: 'erro'
  }[resultado.estado] || 'neutro'
  el.className = `consulta-status ${classe}`
  el.innerHTML = esc(resultado.mensagem) + (resultado.estado === CONSULTA.FORA_DA_BASE
    ? ` <button type="button" class="btn mini" onclick="cadastrarClienteDoPedido('${esc(documento)}')">Cadastrar agora</button>`
    : '')
}

window.cadastrarClienteDoPedido = doc => abrirCadastroNovo(doc)

async function consultarDocumentoPedido() {
  const campo = document.getElementById('ped-cliente-doc')
  const digitos = normalizarDocumento(campo.value)
  if (!digitos) { mostrarStatusPedido(null); return }
  if (digitos.length !== 11 && digitos.length !== 14) { mostrarStatusPedido(null); return }

  mostrarStatusPedido({ estado: 'INCOMPLETO', mensagem: 'Consultando a base...' })
  const r = await consultarPorDocumento(digitos)

  if (r.estado === CONSULTA.ENCONTRADO) {
    mostrarStatusPedido(null)
    campo.value = ''
    escolherClientePedido(r.dados)   // carrega o cabeçalho do pedido
    return
  }
  mostrarStatusPedido(r, digitos)
}

document.getElementById('ped-cliente-doc').addEventListener('blur', consultarDocumentoPedido)
document.getElementById('ped-cliente-doc').addEventListener('change', consultarDocumentoPedido)

let cliPickTimer
document.getElementById('ped-cliente-input').addEventListener('input', e => {
  clearTimeout(cliPickTimer)
  const t = e.target.value.trim()
  const box = document.getElementById('ped-cliente-resultados')
  if (t.length < 3) { box.innerHTML = ''; return }
  cliPickTimer = setTimeout(async () => {
    const digitos = t.replace(/\D/g, '')
    const filtros = [`nome.ilike.*${t}*`]
    if (digitos.length >= 3) filtros.push(`documento.like.${digitos}*`)
    const { data } = await db.from('cliente').select('id, nome, documento, cidade, uf, ativo, beneficio_fiscal')
      .or(filtros.join(',')).eq('ativo', true).order('nome').limit(8)
    box.innerHTML = `<div class="opcoes">${(data || []).map(c =>
      `<div class="opcao" onclick='escolherClientePedido(${JSON.stringify(c).replace(/'/g, "&#39;")})'>
        <span><strong>${esc(c.nome)}</strong><br><span class="suave">${fmtDocumento(c.documento)} · ${esc([c.cidade, c.uf].filter(Boolean).join('/') || '')}</span></span>
      </div>`).join('') || '<div class="opcao suave">Nenhum cliente ativo encontrado</div>'}</div>`
  }, 300)
})

window.escolherClientePedido = c => {
  pedidoAtual.cliente = c
  document.getElementById('ped-cliente-resultados').innerHTML = ''
  document.getElementById('ped-cliente-input').value = ''
  renderClienteEscolhido()
  document.getElementById('ped-produto-input').focus()
}

let prodPickTimer
document.getElementById('ped-produto-input').addEventListener('input', e => {
  clearTimeout(prodPickTimer)
  const t = e.target.value.trim()
  const box = document.getElementById('ped-produto-resultados')
  if (!t) { box.innerHTML = ''; return }
  prodPickTimer = setTimeout(async () => {
    const { data } = await consultarProdutos(t, 15)
    box.innerHTML = `<div class="opcoes">${(data || []).map(p =>
      `<div class="opcao" onclick='addItemPedido(${JSON.stringify(p).replace(/'/g, "&#39;")})'>
        <span><strong>${esc(p.medida)}</strong> ${esc(p.marca)} ${esc(p.modelo)}
          ${p.codigo ? `<br><span class="suave">${esc(p.codigo)}</span>` : ''}</span>
        <span class="preco">${fmtReal(p.preco_venda)}</span>
      </div>`).join('') || '<div class="opcao suave">Nenhum pneu encontrado — tente parte da medida ou o código</div>'}</div>`
  }, 300)
})

window.addItemPedido = p => {
  // RN03: preço e custo congelados no momento da inclusão
  const existente = pedidoAtual.itens.find(i => i.produto_id === p.id)
  if (existente) existente.quantidade++
  else pedidoAtual.itens.push({
    produto_id: p.id,
    descricao: [p.medida, p.marca, p.modelo, [p.indice_carga, p.indice_veloc].filter(Boolean).join('')].filter(Boolean).join(' '),
    quantidade: 1,
    preco_unit: Number(p.preco_venda),
    custo_unit: Number(p.custo),
    desconto_valor: 0
  })
  document.getElementById('ped-produto-resultados').innerHTML = ''
  document.getElementById('ped-produto-input').value = ''
  renderItens()
  renderTotais()
}

window.setQtdItem = (i, v) => {
  pedidoAtual.itens[i].quantidade = Math.max(1, parseInt(v) || 1)
  renderItens(); renderTotais()
}
window.setDescItem = (i, v) => {
  pedidoAtual.itens[i].desconto_valor = Math.max(0, parseNumeroBR(v) || 0)
  renderItens(); renderTotais()
}
window.removerItem = i => {
  pedidoAtual.itens.splice(i, 1)
  renderItens(); renderTotais()
}

function subtotalItem(it) {
  return it.preco_unit * it.quantidade - it.desconto_valor
}

function renderItens() {
  const el = document.getElementById('editor-itens')
  const editavel = pedidoAtual.situacao === 'ORCAMENTO'
  if (!pedidoAtual.itens.length) {
    el.innerHTML = '<div class="vazio">Nenhum item. Busque um pneu pela medida acima.</div>'
    return
  }
  el.innerHTML = `<div class="tabela-scroll itens-tabela"><table>
    <tr><th>Item</th><th>Qtd</th><th>Preço unit.</th><th>Desc. item (R$)</th><th>Subtotal</th>${editavel ? '<th></th>' : ''}</tr>
    ${pedidoAtual.itens.map((it, i) => `<tr>
      <td>${esc(it.descricao)}</td>
      <td>${editavel ? `<input class="qtd" value="${it.quantidade}" inputmode="numeric" onchange="setQtdItem(${i}, this.value)">` : it.quantidade}</td>
      <td class="preco">${fmtReal(it.preco_unit)}</td>
      <td>${editavel ? `<input class="desc-item" value="${it.desconto_valor ? String(it.desconto_valor).replace('.', ',') : ''}" placeholder="0" inputmode="decimal" onchange="setDescItem(${i}, this.value)">` : fmtReal(it.desconto_valor)}</td>
      <td class="preco">${fmtReal(subtotalItem(it))}</td>
      ${editavel ? `<td><button class="btn mini" onclick="removerItem(${i})">✕</button></td>` : ''}
    </tr>`).join('')}
  </table></div>`
}

function descontoTotalCalculado(total) {
  const bruto = parseNumeroBR(document.getElementById('ped-desconto').value) || 0
  if (document.getElementById('ped-desconto-tipo').value === '%') {
    return Math.round(total * Math.min(bruto, 100)) / 100
  }
  return bruto
}

function renderTotais() {
  const total = pedidoAtual.itens.reduce((s, it) => s + subtotalItem(it), 0)
  const desc = Math.min(descontoTotalCalculado(total), total)
  const liquido = total - desc
  const custo = pedidoAtual.itens.reduce((s, it) => s + it.custo_unit * it.quantidade, 0)
  const temCusto = custo > 0
  const margem = temCusto && liquido > 0 ? ((liquido - custo) / liquido * 100) : null
  document.getElementById('editor-totais').innerHTML = `
    <div class="tot"><span class="rotulo">Total</span><span class="valor">${fmtReal(total)}</span></div>
    <div class="tot"><span class="rotulo">Desconto</span><span class="valor">${fmtReal(desc)}</span></div>
    <div class="tot destaque"><span class="rotulo">Total líquido</span><span class="valor">${fmtReal(liquido)}</span></div>
    ${margem !== null ? `<div class="tot"><span class="rotulo">Margem</span><span class="valor">${margem.toFixed(1)}%</span></div>` : ''}`
}

;['ped-desconto', 'ped-desconto-tipo'].forEach(id =>
  document.getElementById(id).addEventListener('input', renderTotais))

document.getElementById('btn-salvar-pedido').addEventListener('click', async () => {
  const p = pedidoAtual
  if (!p.cliente) return toast('Selecione o cliente do pedido', true)
  if (!p.itens.length) return toast('Adicione ao menos um item', true)

  // RN07: desconto que leva o item abaixo do custo exige confirmação expressa
  const abaixoCusto = p.itens.filter(it => it.custo_unit > 0 && subtotalItem(it) / it.quantidade < it.custo_unit)
  const total = p.itens.reduce((s, it) => s + subtotalItem(it), 0)
  const desc = Math.min(descontoTotalCalculado(total), total)
  if (abaixoCusto.length || (total > 0 && desc > 0 && p.itens.some(it => it.custo_unit > 0) &&
      (total - desc) < p.itens.reduce((s, it) => s + it.custo_unit * it.quantidade, 0))) {
    if (!confirm('Atenção: o valor final fica ABAIXO DO CUSTO. Confirmar mesmo assim?')) return
  }

  const btn = document.getElementById('btn-salvar-pedido')
  btn.disabled = true
  const { data, error } = await db.rpc('salvar_pedido', {
    p_pedido: {
      id: p.id, cliente_id: p.cliente.id, desconto_valor: desc,
      forma_pagto: document.getElementById('ped-forma-pagto').value.trim(),
      observacao: document.getElementById('ped-observacao').value.trim()
    },
    p_itens: p.itens.map(it => ({
      produto_id: it.produto_id, descricao: it.descricao, quantidade: it.quantidade,
      preco_unit: it.preco_unit.toFixed(2), custo_unit: it.custo_unit.toFixed(2),
      desconto_valor: it.desconto_valor.toFixed(2)
    }))
  })
  btn.disabled = false
  if (error) return toast(error.message, true)
  toast(`Orçamento #${data.numero} salvo`)
  abrirPedido(data.id)
})

// ─── Pedidos: abrir existente ─────────────────────────────────────────────────

window.abrirPedido = async id => {
  const [{ data: p, error }, { data: itens }, { data: movs }] = await Promise.all([
    db.from('pedido').select('*, cliente(id, nome, documento, beneficio_fiscal)').eq('id', id).single(),
    db.from('pedido_item').select('*').eq('pedido_id', id).order('id'),
    db.from('pedido_movimento').select('*').eq('pedido_id', id).order('registrado_em')
  ])
  if (error || !p) return toast('Erro ao abrir pedido', true)

  pedidoAtual = {
    id: p.id, numero: p.numero, situacao: p.situacao, cliente: p.cliente,
    itens: (itens || []).map(it => ({
      produto_id: it.produto_id, descricao: it.descricao, quantidade: it.quantidade,
      preco_unit: Number(it.preco_unit), custo_unit: Number(it.custo_unit),
      desconto_valor: Number(it.desconto_valor)
    }))
  }
  const descTotal = Number(p.desconto_valor)
  document.getElementById('ped-desconto').value = descTotal ? String(descTotal).replace('.', ',') : ''
  document.getElementById('ped-desconto-tipo').value = 'R$'
  document.getElementById('ped-forma-pagto').value = p.forma_pagto || ''
  document.getElementById('ped-observacao').value = p.observacao || ''

  // aba Pedidos pode não estar ativa (vindo da ficha do cliente)
  document.querySelectorAll('.aba').forEach(b => b.classList.toggle('ativa', b.dataset.tab === 'pedidos'))
  document.querySelectorAll('.tela').forEach(t => t.classList.add('oculta'))
  document.getElementById('tab-pedidos').classList.remove('oculta')
  document.getElementById('modal-ficha').classList.add('oculta')
  abrirEditor()

  document.getElementById('editor-movimentos').innerHTML = (movs && movs.length) ? `
    <div class="ficha-secao">Movimentações</div>
    <div class="tabela-scroll"><table>
      <tr><th>Data</th><th>De</th><th>Para</th><th>Motivo</th></tr>
      ${movs.map(m => `<tr>
        <td>${new Date(m.registrado_em).toLocaleString('pt-BR')}</td>
        <td>${m.de ? SITUACAO_ROTULO[m.de] : '—'}</td>
        <td><span class="badge ${m.para.toLowerCase()}">${SITUACAO_ROTULO[m.para]}</span></td>
        <td>${esc(m.motivo || '—')}</td>
      </tr>`).join('')}
    </table></div>` : ''
}

// Novo pedido a partir da ficha do cliente (UC02 A1)
window.novoPedidoDoCliente = id => {
  const c = clientesCache[id]
  if (!c) return
  document.getElementById('modal-ficha').classList.add('oculta')
  document.querySelectorAll('.aba').forEach(b => b.classList.toggle('ativa', b.dataset.tab === 'pedidos'))
  document.querySelectorAll('.tela').forEach(t => t.classList.add('oculta'))
  document.getElementById('tab-pedidos').classList.remove('oculta')
  novoPedido({ id: c.id, nome: c.nome, documento: c.documento, beneficio_fiscal: c.beneficio_fiscal })
}

// ─── Histórico de importações ─────────────────────────────────────────────────

async function loadImportacoes() {
  const { data, error } = await db.from('importacao')
    .select('*, fornecedor(nome)')
    .order('executado_em', { ascending: false })
    .limit(20)
  const el = document.getElementById('lista-importacoes')
  if (error) { el.innerHTML = '<div class="vazio">Erro ao carregar importações.</div>'; return }
  if (!data || !data.length) { el.innerHTML = '<div class="vazio">Nenhuma importação realizada ainda.</div>'; return }
  el.innerHTML = `<div class="tabela-scroll"><table>
    <tr><th>Data</th><th>Fornecedor</th><th>Arquivo</th><th>Criados</th><th>Atualizados</th><th>Rejeitados</th></tr>
    ${data.map(i => `<tr>
      <td>${new Date(i.executado_em).toLocaleString('pt-BR')}</td>
      <td>${esc(i.fornecedor?.nome || '—')}</td>
      <td class="suave">${esc(i.arquivo_nome || '—')}</td>
      <td>${i.qtd_criados}</td>
      <td>${i.qtd_atualizados}</td>
      <td>${i.qtd_rejeitados}</td>
    </tr>`).join('')}
  </table></div>`
}

// ─── Inicialização ────────────────────────────────────────────────────────────

loadFornecedores()
buscarProdutos('')
