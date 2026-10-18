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

  private async tick(): Promise<void> {
    this.inFlight++;
    try {
      const rows: OutboxRow[] = await this.em.transactional(async (tx) => {
        const picked = await tx.execute(
          `SELECT id, aggregate_id, event_type, payload, attempts
           FROM outbox_message
           WHERE published_at IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
           ORDER BY occurred_at ASC
           LIMIT ?
           FOR UPDATE SKIP LOCKED`,
          [this.batchSize],
        );
        return picked as OutboxRow[];
      });

      for (const row of rows) {
        try {
          await sqs.send(
            new SendMessageCommand({
              QueueUrl: QUEUE_URLS.events,
              MessageBody: JSON.stringify(row.payload),
              MessageGroupId: row.aggregate_id,
              MessageDeduplicationId: row.id,
            }),
          );
          await this.em.transactional(async (tx) => {
            await tx.execute(
              `UPDATE outbox_message SET published_at = NOW() WHERE id = ? AND published_at IS NULL`,
              [row.id],
            );
          });
        } catch (err) {
          await this.em.transactional(async (tx) => {
            await tx.execute(
              `UPDATE outbox_message
               SET attempts = attempts + 1,
                   next_attempt_at = NOW() + (LEAST(POWER(2, attempts + 1) * INTERVAL '1 second', INTERVAL '60 seconds'))
               WHERE id = ? AND published_at IS NULL`,
              [row.id],
            );
          });
          console.error(JSON.stringify({
            level: 'error', worker: 'outbox', eventType: row.event_type,
            outboxId: row.id, attempts: row.attempts + 1, error: String(err),
          }));
        }
      }
    } finally {
      this.inFlight--;
    }
  }

  async tickOnce(): Promise<void> {
    await this.tick();
  }
}
