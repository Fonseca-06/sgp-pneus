# SGP Pneus

Sistema de gestão de clientes, preços e pedidos para loja de pneus (cliente Uendel).

Documentação completa (Visão, Requisitos, Casos de Uso, Arquitetura, Plano de Testes) em
`Documents/02 - Trabalho/Clientes/Uendel/documentos/SGP`.

## Stack

- HTML/CSS/JS puro (sem framework)
- Supabase (PostgreSQL + Auth) — projeto `sgp-pneus` (`xlpxbqyfdwhmfuoexgwm`, sa-east-1)
- Deploy futuro: Vercel

## Rodar localmente

```bash
python3 server.py
# abre http://localhost:8020
```

## Estado atual

- [x] Schema completo do banco (10 tabelas, ENUMs, RLS ligado com políticas provisórias de dev)
- [x] RPC `importar_precos` — importação atômica (tudo-ou-nada, RN10)
- [x] Módulo Produtos: busca por medida normalizada, cadastro/edição manual, importação CSV com prévia
- [ ] Módulo Clientes
- [ ] Módulo Pedidos + situações
- [ ] PDF do orçamento
- [ ] Autenticação e perfis (ADMIN/VENDEDOR) com RLS de verdade
