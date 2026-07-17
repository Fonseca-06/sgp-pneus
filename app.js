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

// Forma canônica de gravação/exibição: "175/70 R13" (RN01)
function medidaCanonica(m) {
  return normMedida(m).replace(/R(\d)/g, ' R$1')
}

// Interpreta a medida digitada de formas variadas (175 70 13, 175/70-13, 175.70.13…)
function parseMedida(input, indice) {
  const up = (input || '').toUpperCase()
  const direct = normMedida(up)
  if (indice && indice[direct]) return direct
  const suf = (up.match(/(LT|C)\s*$/) || [''])[0].trim()
  const candidatos = []
  for (const nums of [up.match(/\d+\.?\d+|\d+/g), up.match(/\d+/g)]) {
    if (nums && nums.length >= 3) {
      candidatos.push(normMedida(`${nums[0]}/${nums[1]}R${nums[2]}${suf}`))
      candidatos.push(normMedida(`${nums[0]}/${nums[1]}R${nums[2]}`))
    }
  }
  for (const c of candidatos) if (indice && indice[c]) return c
  return candidatos[0] || direct
}

// Medida reconhecível no padrão largura/perfil aro (linhas fora disso são rejeitadas — UC04 E2)
function medidaValida(canonica) {
  return /^\d{2,3}(\.\d+)?\/\d{2,3}(\.\d+)? R\d{2}(\.\d)?(C|LT)?$/.test(canonica)
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

async function carregarIndiceMedidas() {
  const { data } = await db.from('produto').select('medida').eq('ativo', true).limit(5000)
  indiceMedidas = {}
  for (const p of (data || [])) indiceMedidas[normMedida(p.medida)] = true
}

async function buscarProdutos(termo) {
  const el = document.getElementById('resultado-busca')
  let query = db.from('produto')
    .select('*, fornecedor(nome)')
    .eq('ativo', true)
    .order('preco_venda', { ascending: true })

  if (termo && termo.trim()) {
    if (indiceMedidas === null) await carregarIndiceMedidas()
    const chave = parseMedida(termo, indiceMedidas)
    query = query.eq('medida', medidaCanonica(chave))
  } else {
    query = query.order('atualizado_em', { ascending: false }).limit(50)
  }

  const { data, error } = await query
  if (error) { el.innerHTML = '<div class="vazio">Erro ao consultar produtos.</div>'; return }
  renderProdutos(data || [], termo)
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
        <td>${esc(p.modelo)}</td>
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
