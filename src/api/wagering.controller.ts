import {
  Controller, Post, Get, Param, Body, Headers, HttpCode,
  BadRequestException, NotFoundException, ConflictException,
  UnprocessableEntityException, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Money, InvalidMoneyError } from '../domain/money';
import { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction';
import {
  ProcessWagerTransactionUseCase,
  IdempotencyConflictError,
  WalletNotFoundError,
  CurrencyMismatchOnWalletError,
} from '../application/process-wager-transaction.use-case';
import { AuthGuard } from './auth.guard';

interface CreateTransactionDto {
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

const KIND_SET = new Set(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']);

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(private readonly em: EntityManager) {}

  @Post('wagering/transactions')
  async create(
    @Body() dto: CreateTransactionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!dto) throw new BadRequestException('body is required');
    const required = ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money'] as const;
    for (const k of required) {
      if (!(dto as any)[k]) throw new BadRequestException(`${k} is required`);
    }
    if (!KIND_SET.has(dto.kind)) {
      throw new BadRequestException('kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK');
    }
    if (dto.kind === 'REFUND' || dto.kind === 'ROLLBACK') {
      if (!dto.referenceExternalTransactionId) {
        throw new BadRequestException('referenceExternalTransactionId required for REFUND/ROLLBACK');
      }
    }

    const key = idempotencyKey ?? `${dto.providerId}:${dto.externalTransactionId}`;

    let money: Money;
    try {
      money = Money.from(dto.money);
    } catch (err) {
      if (err instanceof InvalidMoneyError) throw new BadRequestException(err.message);
      throw err;
    }

    try {
      const uc = new ProcessWagerTransactionUseCase(this.em);
      const result = await uc.execute({
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        idempotencyKey: key,
        playerId: dto.playerId,
        walletId: dto.walletId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: dto.kind as WagerTransactionKind,
        money,
        referenceExternalTransactionId: dto.referenceExternalTransactionId,
        correlationId,
      });

      if (result.status === WagerTransactionStatus.Rejected) {
        throw new UnprocessableEntityException({
          transactionId: result.transactionId,
          status: result.status,
          failureCode: result.failureCode,
          balance: result.balance.toJSON(),
          idempotentReplay: result.idempotentReplay,
        });
      }
      return {
        transactionId: result.transactionId,
        status: result.status,
        balance: result.balance.toJSON(),
        idempotentReplay: result.idempotentReplay,
      };
    } catch (err) {
      if (err instanceof IdempotencyConflictError) throw new ConflictException(err.message);
      if (err instanceof WalletNotFoundError) throw new NotFoundException(err.message);
      if (err instanceof CurrencyMismatchOnWalletError) throw new BadRequestException(err.message);
      if (err instanceof UnprocessableEntityException) throw err;
      throw new ServiceUnavailableException('Transient infrastructure error, retry later');
    }
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') transactionId: string) {
    const rows = await this.em.execute(
      `SELECT * FROM wager_transaction WHERE id = ?`,
      [transactionId],
    );
    if (!rows[0]) throw new NotFoundException('Transaction not found');
    const r = rows[0];
    return {
      transactionId: r.id,
      providerId: r.provider_id,
      externalTransactionId: r.external_transaction_id,
      walletId: r.wallet_id,
      playerId: r.player_id,
      kind: r.kind,
      money: { amount: String(r.amount), currency: r.currency },
      status: r.status,
      failureCode: r.failure_code ?? null,
      referenceTransactionId: r.reference_transaction_id ?? null,
      createdAt: r.created_at,
      processedAt: r.processed_at ?? null,
    };
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const rows = await this.em.execute(
      `SELECT * FROM wager_transaction WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    if (!rows[0]) throw new NotFoundException('Transaction not found');
    return this.get(rows[0].id);
  }
}
