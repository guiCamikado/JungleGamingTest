import {
  Controller, Post, Get, Param, Body, Headers, HttpCode,
  BadRequestException, NotFoundException, ConflictException, UseGuards, Query,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money, InvalidMoneyError } from '../domain/money';
import { CreateWalletUseCase, WalletAlreadyExistsError } from '../application/create-wallet.use-case';
import { AuthGuard } from './auth.guard';

interface CreateWalletDto {
  playerId: string;
  initialBalance: { amount: string; currency: string };
}

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(private readonly em: EntityManager) {}

  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateWalletDto, @Headers('x-correlation-id') correlationId?: string) {
    if (!dto?.playerId || !dto?.initialBalance) {
      throw new BadRequestException('playerId and initialBalance are required');
    }
    let money: Money;
    try {
      money = Money.from(dto.initialBalance);
    } catch (err) {
      if (err instanceof InvalidMoneyError) throw new BadRequestException(err.message);
      throw err;
    }
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
      throw err;
    }
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
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
    const limit = Math.min(Number(limitStr ?? 50) || 50, 200);
    const params: unknown[] = [walletId];
    let cursorClause = '';
    if (cursor) {
      // Cursor opaco = base64 de "created_at|id"
      let decoded: { createdAt: string; id: string };
      try {
        decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
      } catch {
        throw new BadRequestException('Invalid cursor');
      }
      cursorClause = `AND (created_at, id) > (?, ?)`;
      params.push(decoded.createdAt, decoded.id);
    }
    const rows = await this.em.execute(
      `SELECT id, wallet_id, transaction_id, direction, amount, currency,
              balance_before_amount, balance_before_currency,
              balance_after_amount, balance_after_currency, created_at
       FROM wallet_ledger_entry
       WHERE wallet_id = ? ${cursorClause}
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      [...params, limit],
    );
    const items = rows.map((r: any) => ({
      id: r.id,
      transactionId: r.transaction_id,
      direction: r.direction,
      money: { amount: String(r.amount), currency: r.currency },
      balanceBefore: { amount: String(r.balance_before_amount), currency: r.balance_before_currency },
      balanceAfter: { amount: String(r.balance_after_amount), currency: r.balance_after_currency },
      createdAt: r.created_at,
    }));
    const last = items[items.length - 1];
    const nextCursor = last
      ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64')
      : null;
    return { items, nextCursor };
  }
}
