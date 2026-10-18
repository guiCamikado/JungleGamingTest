import { describe, it, expect } from 'bun:test';
import { validateWagerRequest, validateIdempotencyKey, InvalidWagerRequestError } from './wager-request';

const base = () => ({
  providerId: 'provider-a',
  externalTransactionId: 'tx-1',
  playerId: '22222222-2222-2222-2222-222222222222',
  walletId: '11111111-1111-1111-1111-111111111111',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '10.00', currency: 'BRL' },
});

describe('validateWagerRequest', () => {
  it('aceita payload válido', () => {
    const r = validateWagerRequest(base());
    expect(r.money.toJSON()).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  it('rejeita body que não é objeto', () => {
    for (const b of [null, undefined, 'x', 1, []]) {
      expect(() => validateWagerRequest(b)).toThrow(InvalidWagerRequestError);
    }
  });

  it('rejeita UUID inválido em walletId/playerId', () => {
    expect(() => validateWagerRequest({ ...base(), walletId: 'nao-e-uuid' })).toThrow(InvalidWagerRequestError);
    expect(() => validateWagerRequest({ ...base(), playerId: '123' })).toThrow(InvalidWagerRequestError);
  });

  it('rejeita kind inválido e OPENING', () => {
    expect(() => validateWagerRequest({ ...base(), kind: 'FOO' })).toThrow(InvalidWagerRequestError);
    expect(() => validateWagerRequest({ ...base(), kind: 'OPENING' })).toThrow(InvalidWagerRequestError);
  });

  it('rejeita money inválido, zero (exceto LOSS) e negativo', () => {
    expect(() => validateWagerRequest({ ...base(), money: { amount: '1.234', currency: 'BRL' } })).toThrow(InvalidWagerRequestError);
    expect(() => validateWagerRequest({ ...base(), money: { amount: '0.00', currency: 'BRL' } })).toThrow(InvalidWagerRequestError);
    expect(() => validateWagerRequest({ ...base(), money: { amount: '-5.00', currency: 'BRL' } })).toThrow(InvalidWagerRequestError);
    expect(() => validateWagerRequest({ ...base(), kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } })).not.toThrow();
  });

  it('exige referenceExternalTransactionId em REFUND/ROLLBACK', () => {
    expect(() => validateWagerRequest({ ...base(), kind: 'REFUND' })).toThrow(InvalidWagerRequestError);
    expect(() => validateWagerRequest({ ...base(), kind: 'ROLLBACK', referenceExternalTransactionId: 'x' })).not.toThrow();
  });

  it('rejeita campos de texto vazios ou longos demais', () => {
    expect(() => validateWagerRequest({ ...base(), providerId: '' })).toThrow(InvalidWagerRequestError);
    expect(() => validateWagerRequest({ ...base(), providerId: 'x'.repeat(65) })).toThrow(InvalidWagerRequestError);
    expect(() => validateWagerRequest({ ...base(), gameId: 123 })).toThrow(InvalidWagerRequestError);
  });
});

describe('validateIdempotencyKey', () => {
  it('rejeita vazia e longa demais', () => {
    expect(() => validateIdempotencyKey('')).toThrow(InvalidWagerRequestError);
    expect(() => validateIdempotencyKey('k'.repeat(257))).toThrow(InvalidWagerRequestError);
    expect(validateIdempotencyKey('ok')).toBe('ok');
  });
});
