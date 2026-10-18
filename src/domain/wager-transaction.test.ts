import { describe, it, expect } from 'bun:test';
import { Money } from './money';
import { WagerTransaction, WagerTransactionKind, InvalidWagerAmountError } from './wager-transaction';

const create = (kind: WagerTransactionKind, amount: string) =>
  WagerTransaction.create({
    id: 'id', providerId: 'p', externalTransactionId: 'e', idempotencyKey: 'k', payloadHash: 'h',
    walletId: 'w', playerId: 'pl', roundId: 'r', gameId: 'g', kind,
    money: Money.from({ amount, currency: 'BRL' }),
    referenceExternalTransactionId: 'ref',
    createdAt: new Date(),
  });

describe('WagerTransaction.create — valores', () => {
  it('rejeita valor zero para BET, WIN, REFUND e ROLLBACK', () => {
    for (const k of [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      expect(() => create(k, '0.00')).toThrow(InvalidWagerAmountError);
    }
  });

  it('rejeita valor negativo', () => {
    expect(() => create(WagerTransactionKind.Bet, '-1.00')).toThrow(InvalidWagerAmountError);
  });

  it('LOSS aceita valor zero (não gera lançamento)', () => {
    expect(() => create(WagerTransactionKind.Loss, '0.00')).not.toThrow();
  });
});
