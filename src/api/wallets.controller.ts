import {
  Controller, Post, Get, Param, Body, Headers, HttpCode,
  BadRequestException, NotFoundException, ConflictException, UseGuards, Query,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money, InvalidMoneyError } from '../domain/money';
import { NegativeBalanceError } from '../domain/wallet';
import { CreateWalletUseCase, WalletAlreadyExistsError } from '../application/create-wallet.use-case';
import { isUuid } from '../application/wager-request';
import { AuthGuard } from './auth.guard';
import { toHttpException } from './http-errors';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(private readonly em: EntityManager) {}

  @Post()
  @HttpCode(201)
  async create(@Body() dto: any, @Headers('x-correlation-id') _correlationId?: string) {
    if (!dto || typeof dto !== 'object' || !dto.initialBalance) {
      throw new BadRequestException('playerId and initialBalance are required');
    }
    if (!isUuid(dto.playerId)) throw new BadRequestException('playerId must be a UUID');

    let money: Money;
    try {
      money = Money.from(dto.initialBalance);
    } catch (err) {
      if (err instanceof InvalidMoneyError) throw new BadRequestException(err.message);
      throw err;
    }
    if (money.isNegative()) throw new BadRequestException('initialBalance cannot be negative');

    try {
      const uc = new CreateWalletUseCase(this.em);
      const result = await uc.execute({ playerId: dto.playerId, initialBalance: money });
      return {
        id: result.id,
        playerId: result.playerId,
        balance: result.balance.toJSON(),
        version: result.version,
      };
    } catch (err) {
      if (err instanceof WalletAlreadyExistsError) throw new ConflictException(err.message);
      if (err instanceof NegativeBalanceError) throw new BadRequestException(err.message);
      throw toHttpException(err);
    }
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    this.assertUuid(walletId);
    const rows = await this.em.execute(
      `SELECT id, player_id, currency, balance_amount, balance_currency, version
       FROM wallet WHERE id = ?`,
      [walletId],
    );
    if (!rows[0]) throw new NotFoundException('Wallet not found');
    const r = rows[0];
    return {
      id: r.id,
      playerId: r.player_id,
      balance: { amount: String(r.balance_amount), currency: r.balance_currency },
      version: r.version,
    };
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitStr?: string,
  ) {
    this.assertUuid(walletId);

    let limit = DEFAULT_LIMIT;
    if (limitStr !== undefined) {
      limit = Number(limitStr);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new BadRequestException(`limit must be an integer between 1 and ${MAX_LIMIT}`);
      }
    }

    const params: unknown[] = [walletId];
    let cursorClause = '';
    if (cursor) {
      // Cursor opaco = base64(JSON { createdAt, id })
      let decoded: { createdAt: string; id: string };
      try {
        decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
      } catch {
        throw new BadRequestException('Invalid cursor');
      }
      if (
        typeof decoded?.createdAt !== 'string' ||
        Number.isNaN(Date.parse(decoded.createdAt)) ||
        !isUuid(decoded?.id)
      ) {
        throw new BadRequestException('Invalid cursor');
      }
      cursorClause = `AND (created_at, id) > (?, ?)`;
      params.push(decoded.createdAt, decoded.id);
    }

    // Busca limit+1 para saber se existe próxima página.
    const rows = await this.em.execute(
      `SELECT id, wallet_id, transaction_id, direction, amount, currency,
              balance_before_amount, balance_before_currency,
              balance_after_amount, balance_after_currency, created_at
       FROM wallet_ledger_entry
       WHERE wallet_id = ? ${cursorClause}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      [...params, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map((r: any) => ({
      id: r.id,
      transactionId: r.transaction_id,
      direction: r.direction,
      money: { amount: String(r.amount), currency: r.currency },
      balanceBefore: { amount: String(r.balance_before_amount), currency: r.balance_before_currency },
      balanceAfter: { amount: String(r.balance_after_amount), currency: r.balance_after_currency },
      createdAt: r.created_at,
    }));
    const last = items[items.length - 1];
    const nextCursor = hasMore && last
      ? Buffer.from(JSON.stringify({ createdAt: new Date(last.createdAt).toISOString(), id: last.id })).toString('base64')
      : null;
    return { items, nextCursor };
  }

  /**
   * Reconciliação: recalcula o saldo a partir do ledger e compara com o saldo materializado.
   * Tudo em uma única query (snapshot consistente) e aritmética em NUMERIC, nunca em number.
   */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    this.assertUuid(walletId);
    const rows = await this.em.execute(
      `SELECT w.balance_amount::text AS wallet_balance,
              w.balance_currency AS currency,
              COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::text AS ledger_balance,
              (w.balance_amount - COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END), 0))::text AS difference,
              COUNT(l.id)::int AS entries
       FROM wallet w
       LEFT JOIN wallet_ledger_entry l ON l.wallet_id = w.id
       WHERE w.id = ?
       GROUP BY w.id`,
      [walletId],
    );
    const r = rows[0];
    if (!r) throw new NotFoundException('Wallet not found');
    return {
      walletId,
      currency: r.currency,
      walletBalance: Money.from({ amount: r.wallet_balance, currency: r.currency }).toJSON().amount,
      ledgerBalance: Money.from({ amount: r.ledger_balance, currency: r.currency }).toJSON().amount,
      difference: Money.from({ amount: r.difference, currency: r.currency }).toJSON().amount,
      consistent: /^-?0(\.0+)?$/.test(r.difference),
      entries: r.entries,
    };
  }

  private assertUuid(walletId: string): void {
    if (!isUuid(walletId)) throw new BadRequestException('walletId must be a UUID');
  }
}
