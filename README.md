# Wagering Processor

Serviço NestJS + Bun que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) por HTTP e por SQS FIFO, com saldo materializado, ledger imutável, idempotência persistente e outbox transacional. Decisões de projeto em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Requisitos

- [Bun](https://bun.sh) ≥ 1.3
- Docker + Docker Compose (Postgres 16 e LocalStack/SQS)

## Rodando

```bash
bun install
docker compose up -d          # Postgres + LocalStack (as filas são criadas por localstack-init/)
bun run migration:up          # aplica as migrations
bun run dev                   # API em :3000 (workers: consumer SQS, outbox, pending-reference)
```

Configuração por variáveis de ambiente (defaults já servem para o docker-compose):
`PORT`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `SQS_ENDPOINT`, `SQS_ACCOUNT_ID`,
`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SQS_TRANSACTIONS_QUEUE_URL`,
`SQS_EVENTS_QUEUE_URL`, `SQS_DLQ_URL`. Ver `src/config.ts`.

## Testes

```bash
bun test                      # unitários (domínio + validação), sem dependências externas
bun run test:integration      # use case, concorrência e outbox; exige docker compose up
bun run typecheck
```

## Endpoints

| Método | Rota | Resposta |
|---|---|---|
| POST | `/wallets` | 201 · 400 · 409 |
| GET | `/wallets/:id` | 200 · 400 · 404 |
| GET | `/wallets/:id/ledger?cursor=&limit=` | 200 · 400 |
| POST | `/wallets/:id/reconciliation` | 200 (saldo vs. soma do ledger) · 404 |
| POST | `/wagering/transactions` (header `Idempotency-Key` opcional) | 200 processada/replay · **202** `PENDING_REFERENCE` · 400 · 409 · **422** rejeição de negócio · 503 |
| GET | `/wagering/transactions/:id` | 200 · 404 |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | 200 · 404 |
| GET | `/health/live`, `/health/ready` | 200 · 503 |

## Mensagens SQS

Entrada em `wager-transactions.fifo`:

```json
{ "messageId": "…", "type": "WagerTransactionRequested",
  "data": { "providerId": "…", "externalTransactionId": "…", "playerId": "<uuid>", "walletId": "<uuid>",
            "roundId": "…", "gameId": "…", "kind": "BET", "money": { "amount": "10.00", "currency": "BRL" } } }
```

Eventos de saída em `wager-events.fifo`. Mensagens inválidas/permanentes vão direto para `wager-transactions-dlq.fifo`.
