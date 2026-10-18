# Bloco 1 — Fundação (0h–5h) — INEGOCIÁVEL
- Objetivo: projeto roda, banco sobe, domínio Money + Wallet + entidades prontos.



- 0h–1h — Setup: bun init, NestJS, Docker Compose (Postgres + LocalStack), conexão PG funcionando, bun run dev sobe.

- 1h–2h — Schema SQL (migrations manuais ou MikroORM): tabelas wallet, wallet_ledger_entry, wager_transaction, inbox_message, outbox_message. Constraints críticas:

        UNIQUE(player_id, currency) em wallet
        CHECK(balance >= 0) em wallet
        UNIQUE(wallet_id, transaction_id) em ledger (1 lançamento por wallet/transação)
        UNIQUE(provider_id, external_transaction_id) em wager_transaction
        UNIQUE(idempotency_key) em wager_transaction
        UNIQUE(consumer_name, message_id) em inbox
        Ledger: sem UPDATE/DELETE (não precisa trigger, mas documente; REVOKE é bônus)


2h–4h — Money (decimal.js ou big.js, string "X.XX", factories, add/subtract/equals, validações) + WalletLedgerEntry (imutável, create valida aritmética) + testes de unidade do Money.

4h–5h — Wallet (open, rehydrate, debit/credit com non-negative, version) + testes.

    ✅ Checkpoint 5h: bun test verde em Money e Wallet. Se não chegou aqui, pule tudo e vá pro Bloco 2 com o que tiver.



# Bloco 2 — Núcleo transacional (5h–12h) — INEGOCIÁVEL
- Objetivo: use case único que faz wallet + ledger + outbox + inbox numa transação SQL, com idempotência e lock.

5h–7h — WagerTransaction (create, rehydrate, transições, requiresReference, affectsBalance, matchesPayload) + InboxMessage + OutboxMessage (versões mínimas — sem backoff sofisticado, só markPublished + scheduleRetry com now + 2^attempts segundos).

- 7h–8h — Canonical JSON + payloadHash (função de ordenar chaves + SHA-256). Documente o algoritmo.

- 8h–11h — Use case ProcessWagerTransaction:

        BEGIN
            inbox insert (se vier de SQS) — ON CONFLICT DO NOTHING
            SELECT wallet FOR UPDATE  ← lock pessimista, simples e correto
            SELECT wager_transaction WHERE idempotency_key ← checa replay/conflito
            se replay → retorna resultado original
            se conflito de payload → erro 409
            aplica regra (BET/WIN/LOSS/REFUND/ROLLBACK)
            INSERT ledger (se afeta saldo)
            UPDATE wallet balance + version
            INSERT outbox (eventos)
            marca transação PROCESSED / REJECTED
        COMMIT

- Lock pessimista (SELECT ... FOR UPDATE) é a escolha certa aqui. Optimistic com retry é mais elegante mas consome tempo de debug. Justifique no ARCHITECTURE.md: "unidade de concorrência = walletId, lock pessimista por linha, sem lock global".

- REFUND/ROLLBACK: resolve referência por (provider_id, ref_external_id). Se não existe → PENDING_REFERENCE + outbox event.

- Non-negative: Wallet.debit lança InsufficientFundsError → transação vira REJECTED com failureCode distinto (INSUFFICIENT_FUNDS vs REVERSAL_WOULD_GO_NEGATIVE).

- 11h–12h — Teste de integração do use case contra Postgres real: BET, WIN, LOSS, REFUND, replay, conflito de payload, saldo insuficiente.

✅ Checkpoint 12h: fluxo feliz + rejeições + replay funcionando contra Postgres real.


# Bloco 3 — API HTTP (12h–16h) — ALTA PRIORIDADE
- 12h–13h — POST /wallets (com OPENING + ledger na mesma transação), GET /wallets/:id, GET /wallets/:id/ledger (cursor = created_at,id opaco via base64).

- 13h–14h — POST /wagering/transactions (header Idempotency-Key obrigatório, default {providerId}:{externalTransactionId}, chama o mesmo use case). Mapeamento de status:

        400 payload inválido (validação de DTO)
        409 conflito de idempotência (mesma key, payload diferente) e wallet duplicada
        422 rejeição de negócio (REJECTED — insufficient funds etc.)
        202 PENDING_REFERENCE
        503 infra transitória
        200 processado

- 14h–15h — GET /wagering/transactions/:id, GET /providers/:pid/wagering/transactions/:extId, POST /wallets/:id/reconciliation (stub que calcula do ledger — 20 linhas), GET /health/live, GET /health/ready (ping PG + SQS).

- 15h–16h — AuthGuard no-op + testes HTTP básicos.

        ✅ Checkpoint 16h: API responde todos os endpoints com status codes corretos.

# Bloco 4 — Mensageria (16h–20h) — ALTA PRIORIDADE (15 pontos)
- 16h–17h — Consumer SQS: poll da fila FIFO, dedup via inbox na mesma transação do use case, ack só após commit. Distinguir erro de negócio (ack) de transitório (não ack, deixa visibilidade expirar) de permanente (manda DLQ).

- 17h–18h — Outbox publisher: worker que faz SELECT ... WHERE published_at IS NULL AND next_attempt_at <= now() FOR UPDATE SKIP LOCKED LIMIT 10, publica na SQS, markPublished ou scheduleRetry. Roda a cada 1s.

- 18h–19h — Worker de PENDING_REFERENCE: varre transações PENDING_REFERENCE, tenta reprocessar, incrementa contador, após N tentativas (ex.: 5) → REJECTED com REFERENCE_NOT_FOUND + outbox.

- 19h–20h — SIGTERM handler: para de puxar mensagens, espera as em andamento, fecha. Teste básico de redelivery (publica 2x, vê 1 efeito).

        ✅ Checkpoint 20h: mensagem SQS → processa → evento outbox → publica. Redelivery não duplica.

# Bloco 5 — Testes de concorrência (20h–23h) — CRÍTICO (20 pontos)
- Esses testes são o coração da avaliação. Não corte.

- 20h–21h — Cenário obrigatório (seção 8): saldo 100, duas apostas de 80 em paralelo → 1 PROCESSED, 1 REJECTED, saldo 20, 1 débito no ledger. Use Promise.all com duas conexões/instâncias.

- 21h–22h — 50x a mesma aposta em paralelo → 1 débito. E REFUND antes da BET → PENDING_REFERENCE → worker resolve.

- 22h–23h — ≥3 instâncias processando wallets distintas em paralelo (pode ser 3 processos bun apontando pro mesmo PG). Invariante final: wallet.balance == SUM(ledger).

- Se sobrar: worker morto após commit antes do ack (mata processo, reinicia, vê que não duplicou).

        ✅ Checkpoint 23h: os 3 testes de race acima passando com Postgres real.


# Bloco 6 — Fechamento (23h–24h) — OBRIGATÓRIO
23h–23h30 — ARCHITECTURE.md:

decisão de lock (pessimista, por wallet, justificativa)

canonical JSON + algoritmo de hash
taxonomia de failureCode (tabela: código → HTTP → semântica → reenvio?)

auth: "não implementado, desenho seria IdP externo via ProviderIdentityPort, ponto de extensão em AuthGuard"

trade-offs e limitações honestas (o que ficou de fora e por quê)

23h30–24h — README.md: docker compose up, bun run migration, bun run dev, bun test, bun run test:integration. Rodar bun test uma última vez.