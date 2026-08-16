# SUGESTÕES

Coisas notadas durante a F1 que **ninguém pediu**. Ficam aqui, fora dos commits de fatia,
conforme a regra 2 do briefing. Cada uma precisa de decisão antes de virar trabalho.

---

## 1. `parseNumeroBR('1.234')` devolve 1,234 — não mil duzentos e trinta e quatro

`app.js:124`. A heurística compara a posição da última vírgula com a do último ponto.
Sem vírgula, o ponto é tratado como decimal.

```js
parseNumeroBR('1.234,56')  // 1234.56  ✅
parseNumeroBR('1.234')     // 1.234    ⚠️  um pneu de R$ 1.234 importa como R$ 1,23
```

**Risco:** planilha de fornecedor que escreve milhar com ponto e omite os centavos
importa preço 1000× menor. Passa silenciosamente — não é linha rejeitada.

**Por que não corrigi:** é ambíguo de verdade (`1.234` pode ser decimal num arquivo em
formato americano) e mudar a regra altera a importação de preço, que é decisão de negócio.
O comportamento atual está **travado por teste** (`test/regressao-dominio.test.js`), então
qualquer mudança futura é deliberada.

**Opções:** (a) usar o `decimal_sep` do `perfil_importacao` do fornecedor, que já existe no
schema e hoje não é consultado; (b) rejeitar a linha quando ambíguo e mostrar no relatório.

---

## 2. Sem migrações versionadas

O schema inteiro (10 tabelas, ENUMs, RLS, 3 RPCs) só existe no Supabase. O repositório
não tem uma linha de SQL.

**Consequências:** não dá para recriar o ambiente; não dá para revisar mudança de schema;
a regra 6 do briefing ("toda migração tem `down` testado") é hoje **impossível de cumprir**;
o RNF17 (portabilidade sem lock-in) não é verificável.

**Sugestão:** criar `db/migrations/` e começar pelo dump do estado atual como `000_inicial.sql`
antes da F2 tocar em papéis. Custo baixo, destrava a F2.

---

## 3. Gate de tipos via JSDoc

Removi `tsc --noEmit` porque não há TypeScript. Uma alternativa real, sem migrar o projeto:
`checkJs` + anotações JSDoc nas funções de domínio (medida, CSV, cálculo do pedido).
Pega erro de tipo onde importa, sem reescrever nada.

**Custo:** algumas horas + ruído inicial. **Ganho:** o gate de tipos que o briefing queria.

---

## 4. `app.js` com 1.334 linhas em arquivo único

Utilidades, medida, CSV, produtos, clientes e pedidos no mesmo arquivo, em escopo global.
Funciona, mas cada fatia nova aumenta a chance de colisão de nome e dificulta o teste
isolado (por isso o harness precisa subir o app inteiro no jsdom).

**Sugestão:** ao chegar na F3, extrair a camada de consulta para `js/consulta.js` como
módulo ES, em vez de acrescentar mais uma função ao arquivo. Divide sem refatorar tudo.

---

## 5. Backup do banco não existe

RNF14/RNF15 pedem cópia semanal com restauração testada; **CT41 é impeditivo** no plano
de testes. Não há rotina configurada. O plano gratuito do Supabase tem retenção curta.

Não é código, mas bloqueia o aceite do MVP tanto quanto qualquer requisito funcional.

---

## 6. `LISTA FROTA MG` continua sem uso

Segunda tabela de preço (venda para frotista) recebida junto com a lista principal e
nunca importada. Se o representante atende frota, é provável que ela seja necessária —
mas ninguém pediu, então fica registrado.
