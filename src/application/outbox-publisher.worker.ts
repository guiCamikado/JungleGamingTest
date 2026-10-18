import { EntityManager } from '@mikro-orm/postgresql';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { sqs, QUEUE_URLS } from '../infrastructure/messaging/sqs.client';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export class OutboxPublisherWorker {
  private running = false;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private inFlight = 0;

  constructor(
    private readonly em: EntityManager,
    private readonly pollMs = 1000,
    private readonly batchSize = 10,
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
        await this.tick();
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', worker: 'outbox', message: 'tick failed', error: String(err) }));
      } finally {
        this.loop();
      }
    }, this.pollMs);
  }

  /**
   * Um ciclo: seleciona, publica e marca publicado DENTRO da mesma transação, mantendo o
   * lock (FOR UPDATE SKIP LOCKED) até o commit. Assim dois publishers nunca pegam as mesmas
   * linhas. Se o commit falhar depois do envio, a reentrega usa o mesmo MessageDeduplicationId
   * (id da linha), então a FIFO descarta o duplicado.
   *
   * Ordem por agregado: uma linha só é elegível se não há linha anterior do mesmo agregado
   * ainda não publicada; e, se um envio falha, o restante do agregado é pulado no ciclo.
   */
  private async tick(): Promise<void> {
    this.inFlight++;
    try {
      await this.em.transactional(async (tx) => {
        const rows = (await tx.execute(
          `SELECT id, aggregate_id, event_type, payload, attempts
           FROM outbox_message o
           WHERE o.published_at IS NULL
             AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= NOW())
             AND NOT EXISTS (
               SELECT 1 FROM outbox_message prev
               WHERE prev.aggregate_id = o.aggregate_id
                 AND prev.published_at IS NULL
                 AND prev.occurred_at < o.occurred_at
             )
           ORDER BY o.occurred_at ASC
           LIMIT ?
           FOR UPDATE OF o SKIP LOCKED`,
          [this.batchSize],
        )) as OutboxRow[];

        const failedAggregates = new Set<string>();
        for (const row of rows) {
          if (failedAggregates.has(row.aggregate_id)) continue;
          try {
            await sqs.send(
              new SendMessageCommand({
                QueueUrl: QUEUE_URLS.events,
                MessageBody: JSON.stringify(row.payload),
                MessageGroupId: row.aggregate_id,
                MessageDeduplicationId: row.id,
              }),
            );
            await tx.execute(
              `UPDATE outbox_message SET published_at = NOW() WHERE id = ? AND published_at IS NULL`,
              [row.id],
            );
          } catch (err) {
            failedAggregates.add(row.aggregate_id);
            await tx.execute(
              `UPDATE outbox_message
               SET attempts = attempts + 1,
                   next_attempt_at = NOW() + LEAST(POWER(2, attempts + 1) * INTERVAL '1 second', INTERVAL '60 seconds')
               WHERE id = ? AND published_at IS NULL`,
              [row.id],
            );
            console.error(JSON.stringify({
              level: 'error', worker: 'outbox', eventType: row.event_type,
              outboxId: row.id, attempts: row.attempts + 1, error: String(err),
            }));
          }
        }
      });
    } finally {
      this.inFlight--;
    }
  }

  async tickOnce(): Promise<void> {
    await this.tick();
  }
}
