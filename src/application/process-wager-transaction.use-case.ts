import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { Money } from '../domain/money';
import { Wallet, NegativeBalanceError } from '../domain/wallet';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type FailureCode,
} from '../domain/wager-transaction';
import { WalletLedgerEntry, LedgerDirection } from '../domain/wallet-ledger-entry';
import { hashWagerBusinessFields } from '../domain/canonical-json';

export class IdempotencyConflictError extends Error {
  constructor(msg: string) { super(msg); this.name = 'IdempotencyConflictError'; }
}
export class WalletNotFoundError extends Error {
  constructor(id: string) { super(`Wallet not found: ${id}`); this.name = 'WalletNotFoundError'; }
}
export class CurrencyMismatchOnWalletError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: wallet=${a}, transaction=${b}`);
    this.name = 'CurrencyMismatchOnWalletError';
  }
}

export interface ProcessWagerInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  consumerName?: string;
  messageId?: string;
  correlationId?: string;
}

export interface ProcessWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: Money;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

interface WalletRow {
  id: string; player_id: string; currency: string;
  balance_amount: string; balance_currency: string;
  version: number; created_at: Date; updated_at: Date;
}
interface WagerRow {
  id: string; provider_id: string; external_transaction_id: string;
  idempotency_key: string; payload_hash: string; wallet_id: string;
  player_id: string; round_id: string; game_id: string;
  kind: string; amount: string; currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string; failure_code: string | null;
  created_at: Date; processed_at: Date | null;
}

/** Tipos que um ROLLBACK pode referenciar (REFUND só referencia BET). */
const ROLLBACK_REFERENCEABLE: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

export class ProcessWagerTransactionUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(input: ProcessWagerInput): Promise<ProcessWagerResult> {
    const payloadHash = hashWagerBusinessFields({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: input.money.toJSON(),
      referenceExternalTransactionId: input.referenceExternalTransactionId,
    });

    return this.em.transactional(async (tx) => {
      // 1. Lock pessimista por wallet — primeira operação da transação.
      const walletRows = await this.q<WalletRow>(
        tx,
        `SELECT id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at
         FROM wallet WHERE id = ? FOR UPDATE`,
        [input.walletId],
      );
      if (!walletRows[0]) throw new WalletNotFoundError(input.walletId);

      const wallet = Wallet.rehydrate({
        id: walletRows[0].id,
        playerId: walletRows[0].player_id,
        currency: walletRows[0].currency,
        balance: Money.from({
          amount: String(walletRows[0].balance_amount),
          currency: walletRows[0].balance_currency,
        }),
        version: walletRows[0].version,
        createdAt: new Date(walletRows[0].created_at),
        updatedAt: new Date(walletRows[0].updated_at),
      });

      // 2. Inbox dedup (somente SQS). Já processada → ack sem reprocessar.
      if (input.consumerName && input.messageId) {
        const inserted = await this.q<{ id: string }>(
          tx,
          `INSERT INTO inbox_message (id, message_id, consumer_name, payload_hash, received_at)
           VALUES (?, ?, ?, ?, NOW())
           ON CONFLICT (consumer_name, message_id) DO NOTHING
           RETURNING id`,
          [randomUUID(), input.messageId, input.consumerName, payloadHash],
        );
        if (inserted.length === 0) {
          const existing = await this.q<{ processed_at: Date | null }>(
            tx,
            `SELECT processed_at FROM inbox_message WHERE consumer_name = ? AND message_id = ?`,
            [input.consumerName, input.messageId],
          );
          if (existing[0]?.processed_at) {
            return this.replayResult(tx, wallet, input);
          }
        }
      }

      // 3. Idempotência persistente (tabela wager_transaction).
      const existingRows = await this.q<WagerRow>(
        tx,
        `SELECT * FROM wager_transaction WHERE idempotency_key = ?`,
        [input.idempotencyKey],
      );
      let txDomain: WagerTransaction;
      let isExisting = false;
      if (existingRows[0]) {
        const existing = this.rehydrateWager(existingRows[0]);
        if (!existing.matchesPayload(payloadHash)) {
          throw new IdempotencyConflictError(
            `Idempotency key ${input.idempotencyKey} reused with different payload`,
          );
        }
        if (existing.status !== WagerTransactionStatus.PendingReference) {
          await this.markInboxProcessed(tx, input);
          return this.replayResult(tx, wallet, input, existing);
        }
        // PENDING_REFERENCE: tenta resolver a referência agora (worker ou retry).
        txDomain = existing;
        isExisting = true;
      } else {
        if (wallet.currency !== input.money.currency) {
          throw new CurrencyMismatchOnWalletError(wallet.currency, input.money.currency);
        }
        txDomain = WagerTransaction.create({
          id: randomUUID(),
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          walletId: input.walletId,
          playerId: input.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: input.kind,
          money: input.money,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
          createdAt: new Date(),
        });
      }

      // 4. Resolve referência (REFUND / ROLLBACK).
      let reference: WagerTransaction | undefined;
      if (txDomain.requiresReference()) {
        const refRows = await this.q<WagerRow>(
          tx,
          `SELECT * FROM wager_transaction WHERE provider_id = ? AND external_transaction_id = ?`,
          [txDomain.providerId, txDomain.referenceExternalTransactionId],
        );
        reference = refRows[0] ? this.rehydrateWager(refRows[0]) : undefined;

        const referenceUnresolved =
          !reference ||
          reference.status === WagerTransactionStatus.Pending ||
          reference.status === WagerTransactionStatus.PendingReference;

        if (referenceUnresolved) {
          txDomain.markPendingReference();
          if (isExisting) {
            // Retry sem progresso: nada novo a persistir nem a emitir.
            return {
              transactionId: txDomain.id,
              status: WagerTransactionStatus.PendingReference,
              balance: wallet.balance,
              idempotentReplay: true,
            };
          }
          await this.insertTx(tx, txDomain);
          await this.emitPendingReference(tx, txDomain, input);
          await this.markInboxProcessed(tx, input);
          return {
            transactionId: txDomain.id,
            status: WagerTransactionStatus.PendingReference,
            balance: wallet.balance,
            idempotentReplay: false,
          };
        }

        const ref = reference!;
        if (
          ref.status !== WagerTransactionStatus.Processed ||
          ref.providerId !== txDomain.providerId ||
          ref.playerId !== txDomain.playerId ||
          ref.walletId !== txDomain.walletId ||
          ref.roundId !== txDomain.roundId ||
          ref.money.currency !== txDomain.money.currency
        ) {
          return this.rejectAndPersist(tx, txDomain, isExisting, wallet, 'REFERENCE_MISMATCH', input);
        }
        const validKind =
          txDomain.kind === WagerTransactionKind.Refund
            ? ref.kind === WagerTransactionKind.Bet
            : ROLLBACK_REFERENCEABLE.has(ref.kind);
        if (!validKind) {
          return this.rejectAndPersist(tx, txDomain, isExisting, wallet, 'INVALID_REFERENCE_KIND', input);
        }
        if (!ref.money.equals(txDomain.money)) {
          return this.rejectAndPersist(tx, txDomain, isExisting, wallet, 'AMOUNT_MISMATCH', input);
        }
        const alreadyReversed = await this.q(
          tx,
          `SELECT 1 FROM wager_transaction
           WHERE reference_transaction_id = ? AND kind = ? AND status = 'PROCESSED'`,
          [ref.id, txDomain.kind],
        );
        if (alreadyReversed.length > 0) {
          return this.rejectAndPersist(tx, txDomain, isExisting, wallet, 'REFERENCE_ALREADY_REVERSED', input);
        }
      }

      // 5. Aplica a regra de negócio.
      const now = new Date();
      const balanceBefore = wallet.balance;
      let ledgerDir: LedgerDirection | undefined;
      try {
        switch (txDomain.kind) {
          case WagerTransactionKind.Bet:
            wallet.debit(txDomain.money, now);
            ledgerDir = LedgerDirection.Debit;
            break;
          case WagerTransactionKind.Win:
          case WagerTransactionKind.Refund:
            wallet.credit(txDomain.money, now);
            ledgerDir = LedgerDirection.Credit;
            break;
          case WagerTransactionKind.Loss:
            break;
          case WagerTransactionKind.Rollback: {
            // Direção INVERSA da referência (a transação de rollback calcula a inversão).
            ledgerDir = txDomain.ledgerDirectionFor(reference);
            if (ledgerDir === LedgerDirection.Debit) wallet.debit(txDomain.money, now);
            else wallet.credit(txDomain.money, now);
            break;
          }
          default:
            throw new Error(`Kind ${txDomain.kind} not allowed via this use case`);
        }
      } catch (err) {
        if (err instanceof NegativeBalanceError) {
          const code: FailureCode =
            txDomain.kind === WagerTransactionKind.Rollback
              ? 'REVERSAL_WOULD_GO_NEGATIVE'
              : 'INSUFFICIENT_FUNDS';
          return this.rejectAndPersist(tx, txDomain, isExisting, wallet, code, input);
        }
        throw err;
      }

      // 6. Persiste transação, ledger e wallet (mesma transação).
      txDomain.markProcessed(reference?.id, now);
      if (isExisting) await this.updateTx(tx, txDomain);
      else await this.insertTx(tx, txDomain);

      if (ledgerDir) {
        const entry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: txDomain.id,
          direction: ledgerDir,
          money: txDomain.money,
          balanceBefore,
          balanceAfter: wallet.balance,
          createdAt: now,
        });
        await this.q(
          tx,
          `INSERT INTO wallet_ledger_entry
            (id, wallet_id, transaction_id, direction, amount, currency,
             balance_before_amount, balance_before_currency,
             balance_after_amount, balance_after_currency, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.id, entry.walletId, entry.transactionId, entry.direction,
            entry.money.toJSON().amount, entry.money.currency,
            entry.balanceBefore.toJSON().amount, entry.balanceBefore.currency,
            entry.balanceAfter.toJSON().amount, entry.balanceAfter.currency,
            entry.createdAt,
          ],
        );

        await this.q(
          tx,
          `UPDATE wallet SET balance_amount = ?, balance_currency = ?, version = ?, updated_at = ? WHERE id = ?`,
          [
            wallet.balance.toJSON().amount,
            wallet.balance.currency,
            wallet.version,
            wallet.updatedAt,
            wallet.id,
          ],
        );
      }

      // 7. Outbox (mesma transação) + inbox.
      await this.emitProcessed(tx, txDomain, wallet, input);
      if (ledgerDir) {
        await this.emitBalanceChanged(tx, txDomain, wallet, ledgerDir, balanceBefore, input);
      }
      await this.markInboxProcessed(tx, input);

      return {
        transactionId: txDomain.id,
        status: txDomain.status,
        balance: wallet.balance,
        idempotentReplay: false,
      };
    });
  }

  // ============ helpers ============

  /** Executa SQL cru dentro da transação corrente do EntityManager. */
  private async q<T = Record<string, unknown>>(
    tx: EntityManager,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await tx
      .getConnection()
      .execute(sql, params, 'all', tx.getTransactionContext())) as T[];
  }

  private async rejectAndPersist(
    tx: EntityManager,
    t: WagerTransaction,
    isExisting: boolean,
    wallet: Wallet,
    code: FailureCode,
    input: ProcessWagerInput,
  ): Promise<ProcessWagerResult> {
    t.reject(code);
    if (isExisting) await this.updateTx(tx, t);
    else await this.insertTx(tx, t);
    await this.emitRejected(tx, t, input);
    await this.markInboxProcessed(tx, input);
    return {
      transactionId: t.id,
      status: WagerTransactionStatus.Rejected,
      balance: wallet.balance,
      idempotentReplay: false,
      failureCode: code,
    };
  }

  private async insertTx(tx: EntityManager, t: WagerTransaction): Promise<void> {
    await this.q(
      tx,
      `INSERT INTO wager_transaction
        (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
         wallet_id, player_id, round_id, game_id, kind, amount, currency,
         reference_external_transaction_id, reference_transaction_id,
         status, failure_code, created_at, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id, t.providerId, t.externalTransactionId, t.idempotencyKey, t.payloadHash,
        t.walletId, t.playerId, t.roundId, t.gameId, t.kind,
        t.money.toJSON().amount, t.money.currency,
        t.referenceExternalTransactionId ?? null, t.referenceTransactionId ?? null,
        t.status, t.failureCode ?? null, t.createdAt, t.processedAt ?? null,
      ],
    );
  }

  private async updateTx(tx: EntityManager, t: WagerTransaction): Promise<void> {
    await this.q(
      tx,
      `UPDATE wager_transaction
       SET status = ?, failure_code = ?, reference_transaction_id = ?, processed_at = ?
       WHERE id = ?`,
      [t.status, t.failureCode ?? null, t.referenceTransactionId ?? null, t.processedAt ?? null, t.id],
    );
  }

  private async markInboxProcessed(tx: EntityManager, input: ProcessWagerInput): Promise<void> {
    if (!input.consumerName || !input.messageId) return;
    await this.q(
      tx,
      `UPDATE inbox_message SET processed_at = NOW() WHERE consumer_name = ? AND message_id = ?`,
      [input.consumerName, input.messageId],
    );
  }

  /**
   * Resultado de um replay. O saldo devolvido é o saldo pós-operação original
   * (do ledger) quando houve lançamento; caso contrário, o saldo atual.
   */
  private async replayResult(
    tx: EntityManager,
    wallet: Wallet,
    input: ProcessWagerInput,
    known?: WagerTransaction,
  ): Promise<ProcessWagerResult> {
    let t = known;
    if (!t) {
      const rows = await this.q<WagerRow>(
        tx,
        `SELECT * FROM wager_transaction WHERE idempotency_key = ?`,
        [input.idempotencyKey],
      );
      t = rows[0] ? this.rehydrateWager(rows[0]) : undefined;
    }
    let balance = wallet.balance;
    if (t) {
      const ledger = await this.q<{ balance_after_amount: string; balance_after_currency: string }>(
        tx,
        `SELECT balance_after_amount, balance_after_currency
         FROM wallet_ledger_entry WHERE wallet_id = ? AND transaction_id = ?`,
        [wallet.id, t.id],
      );
      if (ledger[0]) {
        balance = Money.from({
          amount: String(ledger[0].balance_after_amount),
          currency: ledger[0].balance_after_currency,
        });
      }
    }
    return {
      transactionId: t?.id ?? input.idempotencyKey,
      status: t?.status ?? WagerTransactionStatus.Processed,
      balance,
      idempotentReplay: true,
      failureCode: t?.failureCode,
    };
  }

  private rehydrateWager(r: WagerRow): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: r.id,
      providerId: r.provider_id,
      externalTransactionId: r.external_transaction_id,
      idempotencyKey: r.idempotency_key,
      payloadHash: r.payload_hash,
      walletId: r.wallet_id,
      playerId: r.player_id,
      roundId: r.round_id,
      gameId: r.game_id,
      kind: r.kind as WagerTransactionKind,
      money: Money.from({ amount: String(r.amount), currency: r.currency }),
      referenceExternalTransactionId: r.reference_external_transaction_id ?? undefined,
      createdAt: new Date(r.created_at),
      status: r.status as WagerTransactionStatus,
      referenceTransactionId: r.reference_transaction_id ?? undefined,
      failureCode: (r.failure_code as FailureCode) ?? undefined,
      processedAt: r.processed_at ? new Date(r.processed_at) : undefined,
    });
  }

  private async enqueueOutbox(
    tx: EntityManager,
    eventType: string,
    aggregateId: string,
    data: Record<string, unknown>,
    correlationId: string,
  ): Promise<void> {
    const payload = {
      eventId: randomUUID(),
      eventType,
      aggregateId,
      correlationId,
      occurredAt: new Date().toISOString(),
      version: 1,
      data,
    };
    await this.q(
      tx,
      `INSERT INTO outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts)
       VALUES (?, ?, ?, ?::jsonb, NOW(), 0)`,
      [randomUUID(), aggregateId, eventType, JSON.stringify(payload)],
    );
  }

  private async emitProcessed(
    tx: EntityManager, t: WagerTransaction, wallet: Wallet, input: ProcessWagerInput,
  ): Promise<void> {
    await this.enqueueOutbox(tx, 'WagerTransactionProcessed', t.id, {
      transactionId: t.id,
      walletId: t.walletId,
      playerId: t.playerId,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      kind: t.kind,
      money: t.money.toJSON(),
      balance: wallet.balance.toJSON(),
      referenceTransactionId: t.referenceTransactionId ?? null,
    }, input.correlationId ?? t.id);
  }

  private async emitRejected(
    tx: EntityManager, t: WagerTransaction, input: ProcessWagerInput,
  ): Promise<void> {
    await this.enqueueOutbox(tx, 'WagerTransactionRejected', t.id, {
      transactionId: t.id,
      walletId: t.walletId,
      playerId: t.playerId,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      kind: t.kind,
      failureCode: t.failureCode ?? 'UNKNOWN_ERROR',
    }, input.correlationId ?? t.id);
  }

  private async emitBalanceChanged(
    tx: EntityManager, t: WagerTransaction, wallet: Wallet,
    direction: LedgerDirection, balanceBefore: Money, input: ProcessWagerInput,
  ): Promise<void> {
    await this.enqueueOutbox(tx, 'WalletBalanceChanged', wallet.id, {
      walletId: wallet.id,
      transactionId: t.id,
      direction,
      money: t.money.toJSON(),
      balanceBefore: balanceBefore.toJSON(),
      balanceAfter: wallet.balance.toJSON(),
      walletVersion: wallet.version,
    }, input.correlationId ?? t.id);
  }

  private async emitPendingReference(
    tx: EntityManager, t: WagerTransaction, input: ProcessWagerInput,
  ): Promise<void> {
    await this.enqueueOutbox(tx, 'WagerTransactionPendingReference', t.id, {
      transactionId: t.id,
      walletId: t.walletId,
      providerId: t.providerId,
      externalTransactionId: t.externalTransactionId,
      referenceExternalTransactionId: t.referenceExternalTransactionId ?? null,
    }, input.correlationId ?? t.id);
  }
}
