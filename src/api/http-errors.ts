import {
  HttpException, BadRequestException, NotFoundException, ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  IdempotencyConflictError, WalletNotFoundError, CurrencyMismatchOnWalletError,
} from '../application/process-wager-transaction.use-case';
import { InvalidWagerRequestError } from '../application/wager-request';
import { InvalidWagerAmountError, ReferenceRequiredError } from '../domain/wager-transaction';
import { isInvalidInputValue, isUniqueViolation } from '../application/db-errors';

/**
 * Traduz erros do use case / banco para HTTP.
 *   400 entrada inválida · 404 não encontrado · 409 conflito de idempotência/unicidade
 *   503 infraestrutura transitória (e qualquer erro inesperado, que também é logado).
 */
export function toHttpException(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (
    err instanceof InvalidWagerRequestError ||
    err instanceof InvalidWagerAmountError ||
    err instanceof ReferenceRequiredError ||
    err instanceof CurrencyMismatchOnWalletError
  ) {
    return new BadRequestException((err as Error).message);
  }
  if (err instanceof WalletNotFoundError) return new NotFoundException(err.message);
  if (err instanceof IdempotencyConflictError) return new ConflictException(err.message);
  if (isInvalidInputValue(err)) return new BadRequestException('Invalid value in request');
  if (isUniqueViolation(err)) return new ConflictException('Conflicting concurrent request');

  console.error(JSON.stringify({ level: 'error', component: 'http', error: String(err) }));
  return new ServiceUnavailableException('Transient infrastructure error, retry later');
}
