import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import { WalletLedgerEntry, LedgerDirection } from '../domain/wallet-ledger-entry';

export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`Wallet for player ${playerId} / ${currency} already exists`);
    this.name = 'WalletAlreadyExistsError';
  }
}

export interface CreateWalletInput {
  playerId: string;
  initialBalance: Money;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
}

export class CreateWalletUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletResult> {
    return this.em.transactional(async (tx) => {
      // Verifica unicidade
      const existing = await tx.execute(
        `SELECT id FROM wallet WHERE player_id = ? AND currency = ?`,
        [input.playerId, input.initialBalance.currency],
      );
      if (existing.length > 0) {
        throw new WalletAlreadyExistsError(input.playerId, input.initialBalance.currency);
      }

      const walletId = randomUUID();
      const now = new Date();
      const wallet = Wallet.open({
        id: walletId,
        playerId: input.playerId,
        initialBalance: input.initialBalance,
      });

      await tx.execute(
        `INSERT INTO wallet (id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          wallet.id, wallet.playerId, wallet.currency,
          wallet.balance.toJSON().amount, wallet.balance.currency,
          wallet.version, wallet.createdAt, wallet.updatedAt,
        ],
      );

      // Se saldo inicial > 0, cria OPENING + ledger + outbox
      if (input.initialBalance.isPositive()) {
        const openingTx = WagerTransaction.rehydrate({
          id: randomUUID(),
          providerId: 'internal',
          externalTransactionId: `opening:${walletId}`,
          idempotencyKey: `opening:${walletId}`,
          payloadHash: '',
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'opening',
          gameId: 'opening',
          kind: WagerTransactionKind.Opening,
          money: input.initialBalance,
          referenceExternalTransactionId: undefined,
          createdAt: now,
          status: WagerTransactionStatus.Processed,
          processedAt: now,
        });

        await tx.execute(
          `INSERT INTO wager_transaction
            (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, amount, currency,
             reference_external_transaction_id, reference_transaction_id,
             status, failure_code, created_at, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
          [
            openingTx.id, openingTx.providerId, openingTx.externalTransactionId,
            openingTx.idempotencyKey, openingTx.payloadHash,
            openingTx.walletId, openingTx.playerId, openingTx.roundId, openingTx.gameId,
            openingTx.kind, openingTx.money.toJSON().amount, openingTx.money.currency,
            openingTx.status, openingTx.createdAt, openingTx.processedAt,
          ],
        );

        const entry = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: openingTx.id,
          direction: LedgerDirection.Credit,
          money: input.initialBalance,
          balanceBefore: Money.zero(input.initialBalance.currency),
          balanceAfter: input.initialBalance,
          createdAt: now,
        });

        await tx.execute(
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

        // Eventos outbox
        await this.enqueueEvent(tx, 'WagerTransactionProcessed', openingTx.id, {
          transactionId: openingTx.id, walletId: wallet.id, playerId: wallet.playerId,
          providerId: openingTx.providerId, externalTransactionId: openingTx.externalTransactionId,
          kind: openingTx.kind, money: openingTx.money.toJSON(),
          balance: wallet.balance.toJSON(), referenceTransactionId: null,
        });
        await this.enqueueEvent(tx, 'WalletBalanceChanged', wallet.id, {
          walletId: wallet.id, transactionId: openingTx.id, direction: LedgerDirection.Credit,
          money: input.initialBalance.toJSON(),
          balanceBefore: Money.zero(wallet.currency).toJSON(),
          balanceAfter: wallet.balance.toJSON(),
          walletVersion: wallet.version,
        });
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance,
        version: wallet.version,
      };
    });
  }

  private async enqueueEvent(
    tx: EntityManager,
    eventType: string,
    aggregateId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const eventId = randomUUID();
    const payload = {
      eventId, eventType, aggregateId, correlationId: aggregateId,
      occurredAt: new Date().toISOString(), version: 1, data,
    };
    await tx.execute(
      `INSERT INTO outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts)
       VALUES (?, ?, ?, ?::jsonb, NOW(), 0)`,
      [randomUUID(), aggregateId, eventType, JSON.stringify(payload)],
    );
  }
}
