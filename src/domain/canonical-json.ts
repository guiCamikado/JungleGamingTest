import { createHash } from 'node:crypto';

/**
 * JSON canônico: chaves ordenadas recursivamente, sem espaços.
 * Algoritmo documentado no ARCHITECTURE.md: SHA-256 hex do JSON canônico
 * do subconjunto de campos de negócio.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

export function payloadHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortDeep(obj[key]);
    }
    return out;
  }
  return value;
}

export interface WagerBusinessFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

export function hashWagerBusinessFields(f: WagerBusinessFields): string {
  return payloadHash({
    providerId: f.providerId,
    externalTransactionId: f.externalTransactionId,
    playerId: f.playerId,
    walletId: f.walletId,
    roundId: f.roundId,
    gameId: f.gameId,
    kind: f.kind,
    money: f.money,
    referenceExternalTransactionId: f.referenceExternalTransactionId ?? null,
  });
}