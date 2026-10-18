import { Money, InvalidMoneyError } from '../domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction';

/** Payload de entrada inválido (HTTP 400 / mensagem SQS permanente → DLQ). */
export class InvalidWagerRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerRequestError';
  }
}

export interface ValidatedWagerRequest {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const ACCEPTED_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/** Limites alinhados às colunas varchar do schema. */
const MAX_LEN = { providerId: 64, externalTransactionId: 128, roundId: 128, gameId: 128, idempotencyKey: 256 };

function str(raw: Record<string, unknown>, key: keyof typeof MAX_LEN): string {
  const v = raw[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new InvalidWagerRequestError(`${key} is required and must be a non-empty string`);
  }
  if (v.length > MAX_LEN[key]) {
    throw new InvalidWagerRequestError(`${key} must have at most ${MAX_LEN[key]} characters`);
  }
  return v;
}

export function validateIdempotencyKey(key: string): string {
  if (key.trim() === '' || key.length > MAX_LEN.idempotencyKey) {
    throw new InvalidWagerRequestError(
      `Idempotency-Key must be non-empty and have at most ${MAX_LEN.idempotencyKey} characters`,
    );
  }
  return key;
}

/** Valida e normaliza o payload de uma transação (HTTP e SQS usam a mesma regra). */
export function validateWagerRequest(input: unknown): ValidatedWagerRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidWagerRequestError('body must be a JSON object');
  }
  const raw = input as Record<string, unknown>;

  const providerId = str(raw, 'providerId');
  const externalTransactionId = str(raw, 'externalTransactionId');
  const roundId = str(raw, 'roundId');
  const gameId = str(raw, 'gameId');

  if (!isUuid(raw.walletId)) throw new InvalidWagerRequestError('walletId must be a UUID');
  if (!isUuid(raw.playerId)) throw new InvalidWagerRequestError('playerId must be a UUID');

  if (typeof raw.kind !== 'string' || !ACCEPTED_KINDS.has(raw.kind)) {
    throw new InvalidWagerRequestError('kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK');
  }
  const kind = raw.kind as WagerTransactionKind;

  const m = raw.money as { amount?: unknown; currency?: unknown } | undefined;
  if (!m || typeof m !== 'object') throw new InvalidWagerRequestError('money is required');
  let money: Money;
  try {
    money = Money.from({ amount: m.amount as string, currency: m.currency as string });
  } catch (err) {
    if (err instanceof InvalidMoneyError) throw new InvalidWagerRequestError(err.message);
    throw err;
  }
  if (money.isNegative()) throw new InvalidWagerRequestError('money.amount cannot be negative');
  if (kind !== WagerTransactionKind.Loss && !money.isPositive()) {
    throw new InvalidWagerRequestError(`${kind} amount must be greater than zero`);
  }

  let referenceExternalTransactionId: string | undefined;
  if (raw.referenceExternalTransactionId !== undefined && raw.referenceExternalTransactionId !== null) {
    if (typeof raw.referenceExternalTransactionId !== 'string' || raw.referenceExternalTransactionId.trim() === '') {
      throw new InvalidWagerRequestError('referenceExternalTransactionId must be a non-empty string');
    }
    if (raw.referenceExternalTransactionId.length > MAX_LEN.externalTransactionId) {
      throw new InvalidWagerRequestError('referenceExternalTransactionId is too long');
    }
    referenceExternalTransactionId = raw.referenceExternalTransactionId;
  }
  if (
    (kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) &&
    !referenceExternalTransactionId
  ) {
    throw new InvalidWagerRequestError('referenceExternalTransactionId is required for REFUND/ROLLBACK');
  }

  return {
    providerId, externalTransactionId, playerId: raw.playerId, walletId: raw.walletId,
    roundId, gameId, kind, money, referenceExternalTransactionId,
  };
}
