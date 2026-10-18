import {
  Controller, Post, Get, Param, Body, Headers, HttpCode, Res,
  NotFoundException, BadRequestException, UnprocessableEntityException, UseGuards,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { ProcessWagerTransactionUseCase } from '../application/process-wager-transaction.use-case';
import {
  validateWagerRequest, validateIdempotencyKey, isUuid,
} from '../application/wager-request';
import { AuthGuard } from './auth.guard';
import { toHttpException } from './http-errors';

/** Subconjunto do Response do Express usado aqui (evita depender de @types/express). */
interface StatusSetter {
  status(code: number): unknown;
}

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(private readonly em: EntityManager) {}

  /**
   * 200 processado (ou replay) · 202 PENDING_REFERENCE · 400 payload inválido ·
   * 409 conflito de idempotência · 422 rejeição de negócio · 503 infra transitória.
   */
  @Post('wagering/transactions')
  @HttpCode(200)
  async create(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: StatusSetter,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    try {
      const req = validateWagerRequest(body);
      const key = validateIdempotencyKey(
        idempotencyKey ?? `${req.providerId}:${req.externalTransactionId}`,
      );

      const uc = new ProcessWagerTransactionUseCase(this.em);
      const result = await uc.execute({ ...req, idempotencyKey: key, correlationId });

      const payload = {
        transactionId: result.transactionId,
        status: result.status,
        balance: result.balance.toJSON(),
        idempotentReplay: result.idempotentReplay,
      };

      if (result.status === WagerTransactionStatus.Rejected) {
        throw new UnprocessableEntityException({ ...payload, failureCode: result.failureCode });
      }
      if (result.status === WagerTransactionStatus.PendingReference) {
        res.status(202);
      }
      return payload;
    } catch (err) {
      throw toHttpException(err);
    }
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') transactionId: string) {
    if (!isUuid(transactionId)) throw new BadRequestException('transactionId must be a UUID');
    const rows = await this.em.execute(
      `SELECT * FROM wager_transaction WHERE id = ?`,
      [transactionId],
    );
    return this.present(rows[0]);
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
    return this.present(rows[0]);
  }

  private present(r: any) {
    if (!r) throw new NotFoundException('Transaction not found');
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
}

