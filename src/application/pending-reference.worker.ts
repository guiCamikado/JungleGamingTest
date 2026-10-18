import { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction';
import { ProcessWagerTransactionUseCase } from './process-wager-transaction.use-case';

interface PendingRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  player_id: string;
  wallet_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
}

/**
 * Reprocessa transações PENDING_REFERENCE (REFUND/ROLLBACK que chegaram antes da referência).
 *
 * Cada tentativa passa pelo mesmo use case (lock da wallet, re-checagem de status), então
 * é seguro rodar em várias instâncias. Backoff quadrático: a tentativa N só é elegível
 * `N² * backoffUnitMs` após a criação; ao atingir MAX_REFERENCE_ATTEMPTS o use case
 * rejeita com REFERENCE_NOT_FOUND e emite WagerTransactionRejected.
 */
export class PendingReferenceWorker {
  private running = false;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private inFlight = 0;

  constructor(
    private readonly em: EntityManager,
    private readonly pollMs = 2000,
    private readonly batchSize = 50,
    private readonly backoffUnitSeconds = 2,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.inFlight > 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.running = false;
  }

  private loop(): void {
    if (!this.running || this.stopping) return;
    this.timer = setTimeout(async () => {
      try {
        await this.tickOnce();
      } catch (err) {
        console.error(JSON.stringify({
          level: 'error', worker: 'pending-reference', message: 'tick failed', error: String(err),
        }));
      } finally {
        this.loop();
      }
    }, this.pollMs);
  }

  /** Uma varredura; exposta para testes. */
  async tickOnce(): Promise<void> {
    this.inFlight++;
    try {
      const rows = (await this.em.execute(
        `SELECT id, provider_id, external_transaction_id, idempotency_key, player_id, wallet_id,
                round_id, game_id, kind, amount, currency, reference_external_transaction_id
         FROM wager_transaction
         WHERE status = 'PENDING_REFERENCE'
           AND created_at + (reference_attempts * reference_attempts * ? * INTERVAL '1 second') <= NOW()
         ORDER BY created_at ASC
         LIMIT ?`,
        [this.backoffUnitSeconds, this.batchSize],
      )) as PendingRow[];

      const uc = new ProcessWagerTransactionUseCase(this.em);
      for (const r of rows) {
        if (this.stopping) break;
        try {
          const res = await uc.execute({
            providerId: r.provider_id,
            externalTransactionId: r.external_transaction_id,
            idempotencyKey: r.idempotency_key,
            playerId: r.player_id,
            walletId: r.wallet_id,
            roundId: r.round_id,
            gameId: r.game_id,
            kind: r.kind as WagerTransactionKind,
            money: Money.from({ amount: String(r.amount), currency: r.currency }),
            referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
            correlationId: r.id,
            pendingRetry: true,
          });
          console.log(JSON.stringify({
            level: 'info', worker: 'pending-reference', transactionId: r.id,
            outcome: res.status, failureCode: res.failureCode,
          }));
        } catch (err) {
          console.error(JSON.stringify({
            level: 'error', worker: 'pending-reference', transactionId: r.id, error: String(err),
          }));
        }
      }
    } finally {
      this.inFlight--;
    }
  }
}
