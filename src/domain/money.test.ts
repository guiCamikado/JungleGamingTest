import { describe, it, expect } from 'bun:test';
import { Money, InvalidMoneyError, CurrencyMismatchError } from './money';

describe('Money', () => {
  it('parses and serializes with fixed scale 2', () => {
    const m = Money.from({ amount: '25.00', currency: 'BRL' });
    expect(m.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(m.toString()).toBe('25.00 BRL');
  });

  it('rejects invalid amounts', () => {
    for (const amount of ['', ' ', 'NaN', 'Infinity', '1e5', '25.001', 'abc', '25,00']) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    }
  });

  it('rejects invalid currency', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: '1.00', currency: 'BR' })).toThrow(InvalidMoneyError);
  });

  it('adds and subtracts same currency', () => {
    const a = Money.from({ amount: '100.00', currency: 'BRL' });
    const b = Money.from({ amount: '25.50', currency: 'BRL' });
    expect(a.add(b).toJSON()).toEqual({ amount: '125.50', currency: 'BRL' });
    expect(a.subtract(b).toJSON()).toEqual({ amount: '74.50', currency: 'BRL' });
  });

  it('throws on currency mismatch', () => {
    const brl = Money.from({ amount: '1.00', currency: 'BRL' });
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  it('compares correctly', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '20.00', currency: 'BRL' });
    expect(a.isLessThan(b)).toBe(true);
    expect(a.isZero()).toBe(false);
    expect(Money.zero('BRL').isZero()).toBe(true);
  });

  it('is immutable', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = a.add(Money.from({ amount: '5.00', currency: 'BRL' }));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('15.00');
  });
});
