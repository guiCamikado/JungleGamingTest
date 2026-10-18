import { describe, it, expect } from 'bun:test';
import { Wallet, NegativeBalanceError } from './wallet';
import { Money, CurrencyMismatchError } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Wallet', () => {
  it('opens with initial balance and version 1', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('100.00') });
    expect(w.balance.toJSON().amount).toBe('100.00');
    expect(w.version).toBe(1);
  });

  it('debits and increments version', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('100.00') });
    w.debit(brl('25.00'));
    expect(w.balance.toJSON().amount).toBe('75.00');
    expect(w.version).toBe(2);
  });

  it('credits and increments version', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('100.00') });
    w.credit(brl('25.00'));
    expect(w.balance.toJSON().amount).toBe('125.00');
    expect(w.version).toBe(2);
  });

  it('rejects debit that would go negative', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('10.00') });
    expect(() => w.debit(brl('20.00'))).toThrow(NegativeBalanceError);
    expect(w.balance.toJSON().amount).toBe('10.00');
    expect(w.version).toBe(1);
  });

  it('rejects currency mismatch', () => {
    const w = Wallet.open({ id: 'w1', playerId: 'p1', initialBalance: brl('10.00') });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => w.debit(usd)).toThrow(CurrencyMismatchError);
  });
});
