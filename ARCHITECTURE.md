# ARCHITECTURE — Distributed Wagering Processor

## 1. Visão geral

Serviço NestJS + Bun que processa transações de apostas de múltiplos provedores via HTTP e SQS FIFO. O núcleo é um **use case único** (`ProcessWagerTransactionUseCase`) compartilhado por ambos os canais, que garante:

- correção financeira (saldo materializado == ledger)
- concorrência segura entre N instâncias
- idempotência persistente
- atomicidade entre wallet, ledger, inbox, outbox

## 2. Modelagem de dinheiro

`Money` é imutável, baseada em `decimal.js`, com **escala fixa 2** e **string como formato canônico**. Nenhum valor monetário passa por `number`, `float` ou `parseFloat`.

**Persistência:** colunas separadas `amount numeric(20,2)` + `currency char(3)`, mapeadas manualmente via SQL direto (`tx.execute`). O domínio não depende de tipos do ORM.

**Por que não `DecimalType` do MikroORM:** requisito explícito da seção 6.1 — o domínio não pode depender de decorators/tipos do ORM.

**Validações:** `Money.from()` rejeita `NaN`, `Infinity`, notação científica, string vazia, >2 casas decimais, entradas não-string. Operações entre moedas diferentes lançam `CurrencyMismatchError`.

## 3. Concorrência

Unidade de concorrência: **`walletId`**. Estratégia: **lock pessimista** via `SELECT ... FOR UPDATE` como **primeira operação** dentro da transação SQL.

**Por que pessimista e não otimista:** BET disputando saldo é o caso crítico. Com otimista, N tentativas concorrentes falham e precisam retry com backoff — latência não-determinística. Com pessimista, apenas acessos à mesma wallet serializam; wallets diferentes correm em paralelo. Sem lock global.

**Cuidado crítico da v7 do MikroORM:** `em.getConnection().execute()` **não** garante binding à transação ativa. Na v7, o Knex foi removido; `tx.execute()` é a API correta, onde `tx` é o `EntityManager` transacional. Descobrimos isso durante o desenvolvimento: `getConnection().execute()` escapava do contexto e cada statement pegava uma conexão diferente do pool, fazendo o `FOR UPDATE` virar autocommit. Correção: `em.transactional(async (tx) => { ... tx.execute(...) })`.

**Cenário obrigatório (seção 8):** validado em `process-wager-transaction.use-case.test.ts` com duas conexões `em.fork()` em `Promise.all`: saldo 100, duas BET de 80 → 1 `PROCESSED`, 1 `REJECTED` (`INSUFFICIENT_FUNDS`), saldo final 20, 1 lançamento `DEBIT`.

## 4. Idempotência

**Duas camadas:**

1. **Idempotency-Key por transação** (`wager_transaction.idempotency_key UNIQUE`):
   - Mesma key + mesmo `payload_hash` → replay (`idempotentReplay: true`)
   - Mesma key + hash diferente → `IdempotencyConflictError` → HTTP 409
   - Default: `{providerId}:{externalTransactionId}`

2. **Inbox persistente por `(consumer_name, message_id)`** (`inbox_message UNIQUE`):
   - `INSERT ... ON CONFLICT DO NOTHING` **antes** de processar
   - Se `processed_at` preenchido → ack imediato sem reprocessar

**Nenhuma idempotência em memória.**

**`payloadHash`** = SHA-256 hex de JSON canônico (chaves ordenadas recursivamente) contendo **apenas campos de negócio**: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId`.

Header `Idempotency-Key` e metadados de transporte **não** entram no hash. Algoritmo: `sha256(JSON.stringify(sortDeep(payload)))` — implementado em `canonical-json.ts`.

## 5. Outbox transacional

Toda operação que altera saldo grava, **na mesma transação SQL**:

1. `wager_transaction` (INSERT ou UPDATE status)
2. `wallet_ledger_entry` (INSERT, imutável — trigger bloqueia UPDATE/DELETE)
3. `wallet` (UPDATE balance + version)
4. `inbox_message` (quando SQS)
5. `outbox_message` (eventos de integração)

**Nunca** publica antes do COMMIT.

**Publisher:** loop 1s com `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 10` — seguro entre N publishers. Após o SELECT (transação curta), publica na SQS, depois `UPDATE outbox_message SET published_at = NOW() WHERE id = ? AND published_at IS NULL` como **barreira atômica final**: se outra instância publicou primeiro, o UPDATE afeta 0 linhas, sem duplicar.

**Fila separada:** eventos de saída vão para `wager-events.fifo`, distinta de `wager-transactions.fifo` (entrada). Isso evita o consumer ler os próprios eventos como requests — foi um bug real descoberto em runtime.

**Falhas:** `attempts++`, `next_attempt_at = NOW() + LEAST(POWER(2, attempts+1) * 1s, 60s)`. Mesmo backoff do `OutboxMessage.scheduleRetry` do domínio.

**Eventos publicados:**
- `WagerTransactionProcessed` — qualquer transação aplicada (incluindo LOSS)
- `WagerTransactionRejected` — rejeição de negócio
- `WalletBalanceChanged` — apenas quando saldo muda
- `WagerTransactionPendingReference` — referência ausente

## 6. Mensageria (SQS)

**Filas:**
- `wager-transactions.fifo` — entrada, consumida por `SqsConsumer`
- `wager-events.fifo` — saída, produzida por `OutboxPublisherWorker`
- `wager-transactions-dlq.fifo` — dead-letter, `maxReceiveCount=5`

**Consumer:**
- Long polling, batch 10, `WaitTimeSeconds: 20`, `VisibilityTimeout: 30`
- Ack (`DeleteMessage`) **só após commit**
- Erro de negócio (`IdempotencyConflict`, `WalletNotFound`, `CurrencyMismatch`): terminal, ack para não travar fila
- Erro transitório (DB down, network): não ack, deixa visibilidade expirar → redelivery
- `ApproximateReceiveCount >= 5`: move para DLQ com `reason`
- Mensagem corrompida (`INVALID_JSON`): ack + DLQ
- Filtro defensivo: se `type !== 'WagerTransactionRequested'`, ack (evita loop de evento em fila errada)
- `SIGTERM`: para de pollar, aguarda `inFlight` zerar (deadline 25s), fecha conexões

## 7. Taxonomia de FailureCode

| Código | HTTP | Semântica | Reenvio? |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | 422 | BET sem saldo | Não |
| `REVERSAL_WOULD_GO_NEGATIVE` | 422 | ROLLBACK que estouraria | Não |
| `REFERENCE_NOT_FOUND` | 422 | PENDING_REFERENCE esgotou tentativas | Não |
| `REFERENCE_MISMATCH` | 422 | provider/player/wallet/round/moeda divergem | Não |
| `INVALID_REFERENCE_KIND` | 422 | REFUND referenciou tipo errado | Não |
| `AMOUNT_MISMATCH` | 422 | valor ≠ referência | Não |
| `REFERENCE_ALREADY_REVERSED` | 422 | já revertida pelo mesmo tipo | Não |
| `CURRENCY_MISMATCH` | 400 | moeda da wallet ≠ transação | Não |
| `OPENING_NOT_ALLOWED` | 400 | OPENING externo | Não |
| `UNKNOWN_ERROR` | 500 | não classificado | Talvez |

`INSUFFICIENT_FUNDS` e `REVERSAL_WOULD_GO_NEGATIVE` são **distintos de propósito** — situações operacionais diferentes (cliente apostou demais vs. operador tentou rollback de transação já usada).

**HTTP:** 400 payload inválido · 404 não encontrado · 409 conflito idempotência/wallet duplicada · 422 rejeição de negócio · 500/503 infra transitória.

## 8. Referências fora de ordem

`REFUND`/`ROLLBACK` com referência ausente → persistido como `PENDING_REFERENCE` + evento `WagerTransactionPendingReference` na outbox.

`PendingReferenceWorker` (stub no timebox): varre `PENDING_REFERENCE` em loop, reprocessa pelo mesmo use case, incrementa `reference_attempts`, após 5 tentativas marca `REJECTED` com `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.

## 9. Autenticação (fora de escopo)

**Não implementada**, conforme seção 2 permite. `AuthGuard` é **no-op** (`canActivate: true`). Em produção:

- IdP externo (Keycloak ou Zitadel) via Docker Compose
- `AuthGuard` validaria JWT e extrairia `providerId`/`playerId` das claims
- `providerId` do body seria validado contra o token — não confiar em body não autenticado

**Ponto de extensão:** `src/api/auth.guard.ts` e o campo `providerId` do use case. Health checks ficam abertos (requisito explícito).

## 10. Trade-offs e limitações

**Decisões que valem justificar:**

- **Lock pessimista por wallet** — mais previsível que otimista; elimina retry não-determinístico.
- **`tx.execute()` em vez de ORM para statements críticos** — controle explícito do `FOR UPDATE`, sem surpresa de flush/identity map.
- **Outbox + fila entrada/saída separadas** — evita que eventos de integração voltem como requests.

**Limitações conhecidas (honestas):**

- `PendingReferenceWorker` é **stub** — interface pronta, lógica completa fora do timebox.
- **Testes de concorrência extras não implementados:** 50× a mesma aposta, ≥3 instâncias, worker morto pós-commit. Os testes existentes cobrem: cenário obrigatório (2 conexões), FOR UPDATE sanity, redelivery (mesmo `messageId` 2×).
- **Reconciliação** endpoint não implementado (ledger já permite auditoria).
- **Observabilidade parcial:** logs JSON estruturados existem (`worker`, `messageId`, `walletId`, `outcome`), sem Prometheus/OpenTelemetry.
- **Auth não implementada** — desenho acima.
- **`PENDING_REFERENCE` sem coluna `reference_attempts`** — o stub não incrementa tentativas.

**O que está sólido:**

- Money sem `number` em nenhum ponto.
- Saldo nunca negativo sob race (validado).
- Idempotência persistente em ambas as camadas.
- Atomicidade wallet + ledger + inbox + outbox.
- Ledger imutável (trigger no schema).
- Outbox com publishers concorrentes sem duplicar.
- Fluxo SQS end-to-end (input → consumer → use case → outbox → events queue).
