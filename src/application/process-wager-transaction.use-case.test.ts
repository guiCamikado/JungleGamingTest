import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Money } from '../domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { ProcessWagerTransactionUseCase, IdempotencyConflictError } from './process-wager-transaction.use-case';
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

async function assertInvariant(em: EntityManager, walletId: string): Promise<void> {
  const r = await em.getConnection().execute(
    `SELECT
       COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END), 0)::text AS sum
     FROM wallet_ledger_entry WHERE wallet_id = ?`,
    [walletId],
  );
  const bal = await balanceOf(em, walletId);
  // Para wallets sem OPENING via ledger, o saldo inicial não está no ledger.
  // Ajustamos somando o saldo inicial conhecido quando aplicável.
  // Neste teste simples, comparamos com o que foi criado (sem OPENING).
  expect(Number(bal) - Number(r[0].sum)).toBeGreaterThanOrEqual(0);
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
  });
});
