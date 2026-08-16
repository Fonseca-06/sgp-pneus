# Mira Sales

Sistema de gestão de clientes, preços e pedidos para representante comercial de pneus
(cliente Uendel). Antes chamado **SGP Pneus** — a renomeação é a fatia F7 do `PLANO.md`.

Não confundir com o **Mira** (`Fonseca-06/mira`), que é o painel de inteligência de preço
do mesmo cliente, em outro repositório e outro banco.

Documentação completa (Visão, Requisitos, Casos de Uso, Arquitetura, Plano de Testes) em
`Documents/02 - Trabalho/Clientes/Uendel/documentos/SGP` — o caminho no disco mantém o
nome antigo de propósito.

## Stack

- HTML/CSS/JS puro (sem framework, sem bundler)
- Supabase (PostgreSQL + Auth) — projeto `xlpxbqyfdwhmfuoexgwm`, sa-east-1
- Deploy futuro: Vercel (bloqueado até a F2 — ver `PLANO.md`, achado A2)

## Rodar localmente

```bash
python3 server.py
# abre http://localhost:8020
```

## Portões

```bash
npm run gates   # build + lint + test
```

| Comando | O que faz |
|---|---|
| `npm run build` | Valida sintaxe, confere que todo `getElementById` tem elemento no HTML, exige cache-bust e proíbe `service_role` no cliente |
| `npm run lint` | ESLint 9 |
| `npm test` | Vitest + jsdom |

## Estado atual

- [x] Schema completo do banco (10 tabelas, ENUMs, RLS com políticas provisórias de dev)
- [x] RPC `importar_precos` — importação atômica (tudo-ou-nada, RN10)
- [x] Módulo Produtos: busca por medida normalizada, cadastro/edição manual, importação CSV com prévia
- [x] Módulo Clientes: busca segmentada, ficha PF/PJ, radar da carteira, benefício fiscal
- [x] Módulo Pedidos: editor de orçamento, preço congelado, descontos, situações e movimentações
- [x] Consulta por CNPJ/CPF que autopreenche cadastro e cabeçalho do pedido (F3/F4/F5)
- [x] Portões executáveis: build, lint e 59 testes
- [ ] PDF do orçamento
- [ ] Autenticação e papel de representante com RLS de verdade (F2 — **bloqueia o deploy**)
- [ ] Comparação de preços entre marcas (F6 — bloqueada por licença dos dados)
