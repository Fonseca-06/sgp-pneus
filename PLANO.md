# PLANO — SGP Pneus → Mira Sales

> Fatia **F1 · Inventário e plano**. Produzido lendo o repositório, não a especificação.
> Onde o briefing e a realidade divergem, este documento registra a realidade.

---

## 1. O que o repositório é de fato

| Briefing dizia | Realidade medida |
|---|---|
| Next.js | **Nenhum framework.** HTML/CSS/JS puro, script clássico via `<script src>` |
| PostgreSQL / **Neon** | PostgreSQL via **Supabase** (`xlpxbqyfdwhmfuoexgwm`, sa-east-1) |
| Vercel | **Não implantado.** Roda em `python3 server.py` → `localhost:8020` |
| `npm run build` | não existia — **sem `package.json`** |
| `npx tsc --noEmit` | não existia — **zero TypeScript no projeto** |
| `npm run lint` | não existia |
| `npm test` | não existia — **zero testes** |

### Arquivos servidos ao navegador

| Arquivo | Linhas | Papel |
|---|---|---|
| `index.html` | 386 | 4 abas (Produtos, Clientes, Pedidos, Configurações) + 5 modais |
| `app.js` | 1.334 | Toda a lógica: utilidades, medida, CSV, produtos, clientes, pedidos |
| `style.css` | 355 | Tema |
| `server.py` | 10 | Servidor local com `Cache-Control: no-store` |
| `importar_clientes.py` / `importar_pneus.py` | 130 / 170 | Carga inicial (rodam fora do app) |

O schema (10 tabelas, ENUMs, RLS, RPCs `importar_precos`, `salvar_pedido`, `mudar_situacao`)
vive **apenas no Supabase**. **Não há migrações versionadas no repositório.**

---

## 2. Achados que mudam o plano

### 🔴 A1 — Não existe modelo de papéis para migrar

A fatia **F2** foi escrita como "migração de `admin`/`vendedor` para `representante`".
Verificação no código:

```
grep -niE "admin|vendedor|perfil" *.js *.html
→ index.html:314  <label>Vendedor responsável        (campo do cadastro do cliente)
→ index.html:320  <label>Parecer do vendedor         (campo do cadastro do cliente)
→ app.js:930      vendedor_nome: v('cli-vendedor')   (coluna da tabela cliente)
→ app.js:932      parecer_vendedor: ...              (coluna da tabela cliente)
```

Essas ocorrências são **dados sobre o cliente** ("qual vendedor atende esta conta"),
não papéis de sistema. Buscas por `auth`, `signIn`, `session`, `login` no `app.js`
retornam **zero** ocorrências funcionais.

**Consequência:** F2 não é adaptação, é **construção do zero** de autenticação,
sessão e autorização. É a maior fatia do lote, não a segunda mais simples.
O ENUM `perfil_usuario ('ADMIN','VENDEDOR')` existe no documento de arquitetura e
possivelmente no banco, mas **nenhuma linha do app o consome**.

### 🔴 A2 — A base de ~49 mil pessoas está exposta hoje

`app.js:1-5` publica a chave `sb_publishable_...` e as políticas RLS são `dev_all`
(liberam tudo). Sem login, **qualquer pessoa com a URL lê a tabela `cliente` inteira**
— nome, CPF/CNPJ, telefone, e-mail, endereço, limite de crédito.

Hoje o dano é limitado porque o app só roda em `localhost`. **Publicar na Vercel sem
resolver isto vira incidente de LGPD no primeiro dia.** A regra 4 do próprio briefing
("não expor a base inteira em endpoint aberto") já está violada.

→ **F2 é pré-requisito de qualquer deploy.** Não é item de higiene, é bloqueio.

### 🟠 A3 — A "base externa" provavelmente já está dentro do sistema

O briefing pede uma base externa que autopreenche o cadastro por CNPJ/CPF.
Mas os **48.891 clientes** hoje na tabela `cliente` vieram de `Base de dados Mira.xlsx`
via `importar_clientes.py` — e o áudio descreve exatamente isso: *"essa base é uma base
que tá pronta"*.

Se for a mesma base, R3/R4 **não são integração com terceiro**. São:
1. separar `base_consulta` (somente leitura, importada) de `cliente` (cadastro próprio); **e**
2. o cadastro passa a *copiar* dados da base de consulta, em vez de nascer vazio.

Isso muda F3 por inteiro — de "cliente HTTP com timeout e cache" para "consulta a uma
tabela local com projeção controlada". **Item bloqueante da F3.** Ver seção 6.

### 🟡 A4 — A busca de cliente já está duplicada

| Local | Linha | Uso |
|---|---|---|
| `buscarClientes()` | `app.js:614` | aba Clientes, com filtros e contagem |
| listener inline `#ped-cliente-input` | `app.js:1096` | cabeçalho do pedido, dropdown |

São duas implementações do mesmo `select` em `cliente`, com colunas e regras diferentes
(a do pedido filtra `.eq('ativo', true)`, a da aba não). A F5 exige que cadastro e pedido
usem a **mesma** camada — então F3 deve **unificar as duas**, não só servir a nova.

### 🟢 A5 — Bugs achados pelos gates novos

Os dois primeiros achados do lint/build foram investigados e são **falsos positivos**,
corrigidos na configuração dos gates (não no app):

- `abrirPedido` "não definido" → existe como `window.abrirPedido` (`app.js:1255`); o ESLint não
  enxerga atribuição via `window`. Declarado como global conhecido na config.
- `getElementById('ficha-pedidos')` sem id no HTML → o elemento é criado em runtime pelo
  próprio `app.js:823`. O verificador passou a aceitar ids criados em template literal.

---

## 3. Gates — corrigidos para o que o repositório realmente usa

Substituem os do briefing. Fixados aqui conforme a própria instrução da F1.

```bash
npm run build   # node scripts/verificar-build.mjs
npm run lint    # eslint .
npm test        # vitest run
npm run gates   # os três em sequência
```

| Gate do briefing | Substituto | Por quê |
|---|---|---|
| `npm run build` | `scripts/verificar-build.mjs` | Não há bundler. O script valida sintaxe (`node --check`), confere que **todo `getElementById` tem elemento correspondente**, exige cache-bust `?v=N` e proíbe `service_role` no código do cliente |
| `npx tsc --noEmit` | **removido** | Não há TypeScript. Fingir um gate de tipos seria teatro. As classes de erro que tipos pegariam ficam com `no-undef`/`no-unused-vars` do ESLint. Adotar JSDoc + `checkJs` é decisão futura — registrado em `SUGESTOES.md` |
| `npm run lint` | `eslint .` | Config nova, `js.configs.recommended` + `eqeqeq`, `no-var`, `no-unused-vars` |
| `npm test` | `vitest run` | 35 testes. `test/harness.js` carrega `index.html` + `app.js` num jsdom com o Supabase dublado — **sem alterar o código de produção** |

### Linha de base de regressão (35 testes, todos verdes)

Amarra o comportamento que **não pode mudar** durante a refatoração:
RN01 normalização de medida · busca maleável (`medidasCorrespondentes`) ·
RF02 validação de CPF/CNPJ · leitura de CSV (separador, BOM, aspas) ·
`parseNumeroBR` · RN03/RF28 cálculo de subtotal e desconto · escape de HTML · telefone.

---

## 4. Plano por fatia, com arquivos nomeados

Cada fatia = 1 commit. Só começa com a anterior verde nos três gates.

### F2 · Autenticação e papel de representante — **replanejada**
| Arquivo | Mudança |
|---|---|
| `db/migrations/001_papeis.sql` (novo) | `ALTER TYPE` ou novo ENUM com `REPRESENTANTE`; tabela `usuario` ligada a `auth.users`; **`down` obrigatório** |
| `db/migrations/002_rls.sql` (novo) | Substitui as políticas `dev_all` por políticas reais por papel |
| `index.html` | Tela de login antes do `<main>`; esconder abas até autenticar |
| `app.js` | `supabase.auth.signInWithPassword`, guarda de sessão, `onAuthStateChange`, logout |
| `test/auth.test.js` (novo) | Sessão ausente → app não renderiza dados; sessão presente → renderiza |

> **Bloqueio:** decidir se o representante enxerga **todos** os clientes ou só a carteira dele
> (seção 6). A resposta define a política RLS e não pode ser adivinhada.

### F3 · Camada única de consulta por documento
| Arquivo | Mudança |
|---|---|
| `app.js` | Nova função `consultarPorDocumento(doc)` — valida DV **antes** de consultar, normaliza, devolve estado tipado: `ENCONTRADO` \| `FORA_DA_BASE` \| `DOCUMENTO_INVALIDO` \| `ERRO_REDE` \| `TIMEOUT` |
| `app.js` | `buscarClientes()` (l. 614) e o listener do pedido (l. 1096) passam a **chamar a mesma função** — elimina a duplicação A4 |
| `test/consulta-documento.test.js` (novo) | Os cinco estados, com o `db` dublado devolvendo cada caso |

> **Bloqueio:** A3 — a base é a tabela local ou um serviço externo?

### F4 · Tela de cadastro com autopreenchimento
| Arquivo | Mudança |
|---|---|
| `index.html` | Campo de documento vira o **primeiro** passo do modal; área de status ("cliente fora da base") |
| `app.js` | Ao sair do campo de documento: consulta → preenche campos → marca origem do dado; se `FORA_DA_BASE`, libera preenchimento manual com aviso |
| `test/cadastro.test.js` (novo) | Os 4 estados navegáveis |

### F5 · Cabeçalho do pedido
| Arquivo | Mudança |
|---|---|
| `index.html` | Campo de CNPJ/CPF no cabeçalho do editor, ao lado da busca por nome |
| `app.js` | Reusa `consultarPorDocumento` da F3 — **proibido reimplementar** |
| `test/pedido-cabecalho.test.js` (novo) | Pedido com cliente da base e com cliente manual |

### F6 · Comparação de preços entre marcas
> **Não iniciar** sem resolver origem e licença dos dados (seção 6). O briefing
> classifica isso como "refinar depois"; tratar como fatia condicionada.

### F7 · Renomeação para Mira Sales
| Arquivo | Mudança |
|---|---|
| `index.html` | `<title>`, `.marca` |
| `package.json` | `name` |
| `README.md` | título e descrição |
| Grafia fixada | pacote `mira-sales` · exibição **Mira Sales** · constantes `MIRA_SALES` |

---

## 5. Ordem revisada e justificativa

O briefing propõe F2 → F3 → F4 → F5 → F6 → F7. Mantida, com um alerta:

**F2 cresceu de "adaptar" para "construir do zero"** (achado A1) e é pré-requisito de
segurança (achado A2). Se a urgência for demonstrar o fluxo para a Fernanda, uma
alternativa é F3 → F4 → F5 primeiro e F2 antes do deploy — **desde que o sistema não
saia de `localhost` até a F2 estar pronta**. Decisão do João Pedro.

---

## 6. Pontos que bloqueiam a entrega

Registrar a resposta aqui conforme forem esclarecidos.

| # | Pergunta | Bloqueia |
|---|---|---|
| 1 | **A base de consulta é a mesma que já está na tabela `cliente`** (48.891 vindos de `Base de dados Mira.xlsx`), ou é um serviço externo separado? | **F3** |
| 2 | Se for externa: API de terceiro, arquivo importado ou banco compartilhado? Tem contrato, custo por consulta e limite de chamada? | **F3** |
| 3 | Representante enxerga **todos** os clientes ou só a carteira dele? | **F2** (define a política RLS) |
| 4 | Cliente cadastrado manualmente sincroniza depois com a base, ou vive só no banco próprio? | **F4** |
| 5 | Origem e licença dos preços de outras empresas — há autorização de uso? | **F6** |
| 6 | O comparativo de preços é informativo ou entra no cálculo do pedido? | **F6** |
| 7 | Fernanda é usuária-piloto? Vale validar a F4 com ela antes de seguir? | F4 (não bloqueia) |
| 8 | Existe stack alvo diferente (Next.js/Neon/Vercel), ou seguimos em HTML/JS + Supabase? | todas |

**Nome:** confirmado **Mira Sales**. Grafia fixada na seção 4 (F7).

---

## 7. Estado da F1

| Gate | Resultado |
|---|---|
| `npm run build` | ✅ verde — 4 arquivos, 92 ids conferidos |
| `npm run lint` | ✅ verde — 0 problemas |
| `npm test` | ✅ verde — 35 testes |

**Critério de pronto da F1** ("`PLANO.md` existe, lista arquivos reais do repo e não propõe
nada fora dos requisitos"): atendido. Nenhuma funcionalidade nova foi codificada nesta fatia —
só infraestrutura de verificação, que é o que a própria F1 manda fixar.
