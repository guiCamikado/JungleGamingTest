import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { getEm, resetDb, closeOrm } from '../test/helpers';
import { sqs, QUEUE_URLS } from '../infrastructure/messaging/sqs.client';
import { OutboxPublisherWorker } from './outbox-publisher.worker';

async function seedOutbox(em: any, eventType: string): Promise<string> {
  const id = randomUUID();
  await em.execute(
    `INSERT INTO outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts)
     VALUES (?, ?, ?, ?::jsonb, NOW(), 0)`,
    [id, randomUUID(), eventType, JSON.stringify({ eventId: id, eventType, data: { test: true } })],
  );
  return id;
}

describe('OutboxPublisherWorker', () => {
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeOrm(); });

  it('publishes pending outbox rows and marks published_at', async () => {
    const em = await getEm();
    const id = await seedOutbox(em, 'TestEvent');

    const worker = new OutboxPublisherWorker(em);
    await worker.tickOnce();

    const rows = await em.execute(`SELECT published_at FROM outbox_message WHERE id = ?`, [id]);
    expect(rows[0].published_at).not.toBeNull();

    // consome da fila para verificar
    const msg = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QUEUE_URLS.events,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    expect(msg.Messages?.length ?? 0).toBeGreaterThan(0);
  });

  it('two concurrent workers do not double-publish', async () => {
    const em = await getEm();
    await seedOutbox(em, 'A');
    await seedOutbox(em, 'B');
    await seedOutbox(em, 'C');

    const w1 = new OutboxPublisherWorker(em);
    const w2 = new OutboxPublisherWorker(em.fork());
    await Promise.all([w1.tickOnce(), w2.tickOnce()]);

    const rows = await em.execute(
      `SELECT COUNT(*)::int AS c FROM outbox_message WHERE published_at IS NOT NULL`,
    );
    expect(rows[0].c).toBe(3);
  });
});
