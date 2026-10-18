import { describe, it, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getEm } from './helpers';

describe('FOR UPDATE sanity', () => {
  it('blocks second transaction', async () => {
    const em = await getEm();
    const walletId = randomUUID();
    await em.execute(
      `INSERT INTO wallet (id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at)
       VALUES (?, ?, 'BRL', '100.00', 'BRL', 1, NOW(), NOW())`,
      [walletId, randomUUID()],
    );

    let t2Duration = 0;
    await Promise.all([
      em.transactional(async (tx) => {
        await tx.execute(`SELECT * FROM wallet WHERE id = ? FOR UPDATE`, [walletId]);
        await new Promise((r) => setTimeout(r, 500));
      }),
      (async () => {
        await new Promise((r) => setTimeout(r, 50));
        await em.fork().transactional(async (tx) => {
          const t2Start = Date.now();
          await tx.execute(`SELECT * FROM wallet WHERE id = ? FOR UPDATE`, [walletId]);
          t2Duration = Date.now() - t2Start;
        });
      })(),
    ]);
    expect(t2Duration).toBeGreaterThan(300);
  });
});
