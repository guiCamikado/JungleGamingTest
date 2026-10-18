import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { ProcessWagerTransactionUseCase, IdempotencyConflictError } from './process-wager-transaction.use-case';
import { PendingReferenceWorker } from './pending-reference.worker';
import { InvalidWagerAmountError } from '../domain/wager-transaction';
import { getEm, resetDb, closeOrm } from '../test/helpers';
import type { EntityManager } from '@mikro-orm/postgresql';

const brl = (a: string) => Money.from({ amount: a, currency: 'BRL' });

async function createWallet(em: EntityManager, initial: string): Promise<{ walletId: string; playerId: string }> {
  const walletId = randomUUID();
  const playerId = randomUUID();
  await em.getConnection().execute(
    `INSERT INTO wallet (id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at)
     VALUES (?, ?, 'BRL', ?, 'BRL', 1, NOW(), NOW())`,
    [walletId, playerId, initial],
  );
  return { walletId, playerId };
}

function makeInput(walletId: string, playerId: string, kind: WagerTransactionKind, amount: string, ext = randomUUID()) {
  return {
    providerId: 'provider-a',
    externalTransactionId: ext,
    idempotencyKey: `provider-a:${ext}`,
    playerId, walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
  };
}

async function balanceOf(em: EntityManager, walletId: string): Promise<string> {
  const r = await em.getConnection().execute(`SELECT balance_amount FROM wallet WHERE id = ?`, [walletId]);
  return r[0].balance_amount;
}

async function ledgerCount(em: EntityManager, walletId: string): Promise<number> {
  const r = await em.getConnection().execute(`SELECT COUNT(*)::int AS c FROM wallet_ledger_entry WHERE wallet_id = ?`, [walletId]);
  return r[0].c;
}

/** Invariante: saldo materializado == saldo inicial + soma assinada do ledger. */
async function assertInvariant(em: EntityManager, walletId: string, initial: string): Promise<void> {
  const r = await em.getConnection().execute(
    `SELECT w.balance_amount::text AS balance,
            (? ::numeric + COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0))::text AS expected
     FROM wallet w LEFT JOIN wallet_ledger_entry l ON l.wallet_id = w.id
     WHERE w.id = ? GROUP BY w.id`,
    [initial, walletId],
  );
  expect(r[0].balance).toBe(r[0].expected);
}

describe('ProcessWagerTransactionUseCase', () => {
  beforeAll(async () => { await getEm(); });
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { await closeOrm(); });

  it('BET com saldo suficiente: PROCESSED, 1 DEBIT', async () => {
    const em = await getEm();
    const { walletId, playerId } = await createWallet(em, '100.00');
    const uc = new ProcessWagerTransactionUseCase(em);
    const res = await uc.execute(makeInput(walletId, playerId, WagerTransactionKind.Bet, '25.00'));
    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(res.balance.toJSON().amount).toBe('75.00');
    expect(await ledgerCount(em, walletId)).toBe(1);
  });

  it('BET com saldo insuficiente: REJECTED INSUFFICIENT_FUNDS, sem ledger', async () => {
    const em = await getEm();
    const { walletId, playerId } = await createWallet(em, '10.00');
    const uc = new ProcessWagerTransactionUseCase(em);
    const res = await uc.execute(makeInput(walletId, playerId, WagerTransactionKind.Bet, '25.00'));
    expect(res.status).toBe(WagerTransactionStatus.Rejected);
    expect(res.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await ledgerCount(em, walletId)).toBe(0);
    expect(await balanceOf(em, walletId)).toBe('10.00');
  });

  it('Replay: idempotentReplay=true sem duplicar débito', async () => {
    const em = await getEm();
    const { walletId, playerId } = await createWallet(em, '100.00');
    const uc = new ProcessWagerTransactionUseCase(em);
    const input = makeInput(walletId, playerId, WagerTransactionKind.Bet, '25.00');
    const r1 = await uc.execute(input);
    const r2 = await uc.execute(input);
    expect(r1.status).toBe(WagerTransactionStatus.Processed);
    expect(r2.idempotentReplay).toBe(true);
    expect(await ledgerCount(em, walletId)).toBe(1);
    expect(await balanceOf(em, walletId)).toBe('75.00');
  });

  it('Mesma key, payload diferente: IdempotencyConflictError', async () => {
    const em = await getEm();
    const { walletId, playerId } = await createWallet(em, '100.00');
    const uc = new ProcessWagerTransactionUseCase(em);
    const input = makeInput(walletId, playerId, WagerTransactionKind.Bet, '25.00');
    await uc.execute(input);
    const conflicting = { ...input, money: brl('30.00') };
    await expect(uc.execute(conflicting)).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('LOSS: PROCESSED, sem ledger, com outbox', async () => {
    const em = await getEm();
    const { walletId, playerId } = await createWallet(em, '100.00');
    const uc = new ProcessWagerTransactionUseCase(em);
    const res = await uc.execute(makeInput(walletId, playerId, WagerTransactionKind.Loss, '10.00'));
    expect(res.status).toBe(WagerTransactionStatus.Processed);
    expect(await ledgerCount(em, walletId)).toBe(0);
    const out = await em.getConnection().execute(`SELECT COUNT(*)::int AS c FROM outbox_message WHERE event_type = 'WagerTransactionProcessed'`);
    expect(out[0].c).toBe(1);
  });

  it('REFUND antes da BET: PENDING_REFERENCE', async () => {
    const em = await getEm();
    const { walletId, playerId } = await createWallet(em, '100.00');
    const uc = new ProcessWagerTransactionUseCase(em);
    const input = { ...makeInput(walletId, playerId, WagerTransactionKind.Refund, '25.00'), referenceExternalTransactionId: 'bet-does-not-exist' };
    const res = await uc.execute(input);
    expect(res.status).toBe(WagerTransactionStatus.PendingReference);
    expect(await ledgerCount(em, walletId)).toBe(0);
  });

  it('CENÁRIO OBRIGATÓRIO: saldo 100, duas BET de 80 em paralelo', async () => {
    const emSetup = await getEm();
    const { walletId, playerId } = await createWallet(emSetup, '100.00');
    const orm = await (await import('../test/helpers')).getOrm();

    const emA = orm.em.fork();
    const emB = orm.em.fork();
    const ucA = new ProcessWagerTransactionUseCase(emA);
    const ucB = new ProcessWagerTransactionUseCase(emB);

const inputA = makeInput(walletId, playerId, WagerTransactionKind.Bet, '80.00', crypto.randomUUID());
const inputB = makeInput(walletId, playerId, WagerTransactionKind.Bet, '80.00', crypto.randomUUID());
    const [ra, rb] = await Promise.allSettled([ucA.execute(inputA), ucB.execute(inputB)]);
    const results = [ra, rb].filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled').map(r => r.value);
    const processed = results.filter(r => r.status === WagerTransactionStatus.Processed);
    const rejected = results.filter(r => r.status === WagerTransactionStatus.Rejected);

    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(emSetup, walletId)).toBe('20.00');
    expect(await ledgerCount(emSetup, walletId)).toBe(1);
    await assertInvariant(emSetup, walletId, '100.00');
  });

  it('BET/WIN com valor zero: rejeitada com InvalidWagerAmountError, sem efeitos', async () => {
    const em = await getEm();
    const { walletId, playerId } = await createWallet(em, '100.00');
    const uc = new ProcessWagerTransactionUseCase(em);
    await expect(
      uc.execute(makeInput(walletId, playerId, WagerTransactionKind.Bet, '0.00')),
    ).rejects.toBeInstanceOf(InvalidWagerAmountError);
    expect(await ledgerCount(em, walletId)).toBe(0);
    const t = await em.getConnection().execute(`SELECT COUNT(*)::int AS c FROM wager_transaction`);
    expect(t[0].c).toBe(0);
  });

  it('50x a mesma aposta em paralelo: 1 débito, 49 replays', async () => {
    const emSetup = await getEm();
    const { walletId, playerId } = await createWallet(emSetup, '100.00');
    const orm = await (await import('../test/helpers')).getOrm();
    const input = makeInput(walletId, playerId, WagerTransactionKind.Bet, '25.00', randomUUID());

    const results = await Promise.all(
      Array.from({ length: 50 }, () => new ProcessWagerTransactionUseCase(orm.em.fork()).execute(input)),
    );

    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(results.filter((r) => !r.idempotentReplay).length).toBe(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await balanceOf(emSetup, walletId)).toBe('75.00');
    expect(await ledgerCount(emSetup, walletId)).toBe(1);
    await assertInvariant(emSetup, walletId, '100.00');
  });

  it('várias wallets em paralelo (simula N instâncias): invariante saldo == soma do ledger', async () => {
    const emSetup = await getEm();
    const orm = await (await import('../test/helpers')).getOrm();
    const wallets = await Promise.all([1, 2, 3].map(() => createWallet(emSetup, '1000.00')));

    const jobs: Promise<unknown>[] = [];
    for (const { walletId, playerId } of wallets) {
      for (let i = 0; i < 20; i++) {
        const kind = i % 3 === 0 ? WagerTransactionKind.Win : WagerTransactionKind.Bet;
        const amount = i % 2 === 0 ? '13.37' : '41.50';
        jobs.push(new ProcessWagerTransactionUseCase(orm.em.fork()).execute(
          makeInput(walletId, playerId, kind, amount, randomUUID()),
        ));
      }
    }
    await Promise.all(jobs);

    for (const { walletId } of wallets) {
      await assertInvariant(emSetup, walletId, '1000.00');
      expect(await ledgerCount(emSetup, walletId)).toBe(20);
    }
  });

  it('REFUND antes da BET: o worker resolve quando a BET chega', async () => {
    const em = await getEm();
    const { walletId, playerId } = await createWallet(em, '100.00');
    const uc = new ProcessWagerTransactionUseCase(em);

    const refund = { ...makeInput(walletId, playerId, WagerTransactionKind.Refund, '25.00'), referenceExternalTransactionId: 'bet-1' };
    expect((await uc.execute(refund)).status).toBe(WagerTransactionStatus.PendingReference);

    const worker = new PendingReferenceWorker(em, 1000, 50, 0);
    await worker.tickOnce(); // BET ainda não existe: continua pendente
    const still = await em.getConnection().execute(`SELECT status, reference_attempts FROM wager_transaction WHERE idempotency_key = ?`, [refund.idempotencyKey]);
    expect(still[0].status).toBe('PENDING_REFERENCE');
    expect(still[0].reference_attempts).toBe(1);

    const bet = { ...makeInput(walletId, playerId, WagerTransactionKind.Bet, '25.00', 'bet-1') };
    await uc.execute(bet);
    expect(await balanceOf(em, walletId)).toBe('75.00');

    await worker.tickOnce();
    const done = await em.getConnection().execute(`SELECT status FROM wager_transaction WHERE idempotency_key = ?`, [refund.idempotencyKey]);
    expect(done[0].status).toBe('PROCESSED');
    expect(await balanceOf(em, walletId)).toBe('100.00');
    expect(await ledgerCount(em, walletId)).toBe(2);
    await assertInvariant(em, walletId, '100.00');
  });

  it('PENDING_REFERENCE sem referência: após 5 tentativas vira REJECTED REFERENCE_NOT_FOUND', async () => {
    const em = await getEm();
    const { walletId, playerId } = await createWallet(em, '100.00');
    const uc = new ProcessWagerTransactionUseCase(em);
    const refund = { ...makeInput(walletId, playerId, WagerTransactionKind.Refund, '25.00'), referenceExternalTransactionId: 'nunca-existe' };
    await uc.execute(refund);

    const worker = new PendingReferenceWorker(em, 1000, 50, 0);
    for (let i = 0; i < 5; i++) await worker.tickOnce();

    const row = await em.getConnection().execute(`SELECT status, failure_code FROM wager_transaction WHERE idempotency_key = ?`, [refund.idempotencyKey]);
    expect(row[0].status).toBe('REJECTED');
    expect(row[0].failure_code).toBe('REFERENCE_NOT_FOUND');
    const out = await em.getConnection().execute(`SELECT COUNT(*)::int AS c FROM outbox_message WHERE event_type = 'WagerTransactionRejected'`);
    expect(out[0].c).toBe(1);
    expect(await balanceOf(em, walletId)).toBe('100.00');
  });

  it('mesmo (provider, externalTransactionId) com outra Idempotency-Key: IdempotencyConflictError (409)', async () => {
    const em = await getEm();
    const { walletId, playerId } = await createWallet(em, '100.00');
    const uc = new ProcessWagerTransactionUseCase(em);
    const input = makeInput(walletId, playerId, WagerTransactionKind.Bet, '25.00');
    await uc.execute(input);
    await expect(uc.execute({ ...input, idempotencyKey: 'outra-chave' })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
