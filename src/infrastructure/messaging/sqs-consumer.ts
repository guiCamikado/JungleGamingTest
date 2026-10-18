import { EntityManager } from '@mikro-orm/postgresql';
import {
  ReceiveMessageCommand, DeleteMessageCommand, SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import {
  ProcessWagerTransactionUseCase,
  IdempotencyConflictError,
  WalletNotFoundError,
  CurrencyMismatchOnWalletError,
} from '../../application/process-wager-transaction.use-case';
import {
  validateWagerRequest,
  InvalidWagerRequestError,
} from '../../application/wager-request';
import { InvalidWagerAmountError, ReferenceRequiredError } from '../../domain/wager-transaction';
import { isInvalidInputValue } from '../../application/db-errors';
import { sqs, QUEUE_URLS } from './sqs.client';

const CONSUMER_NAME = 'wager-transactions-consumer';
const MAX_RECEIVE_COUNT = 5;
const SHUTDOWN_DEADLINE_MS = 25_000;

/** Erro permanente de uma mensagem: reprocessar nunca vai resolver → DLQ imediata. */
function isPermanentError(err: unknown): boolean {
  return (
    err instanceof InvalidWagerRequestError ||
    err instanceof InvalidWagerAmountError ||
    err instanceof ReferenceRequiredError ||
    isInvalidInputValue(err)
  );
}

/** Erro de negócio terminal: o resultado não muda com retry; ack para não travar o grupo FIFO. */
function isTerminalBusinessError(err: unknown): boolean {
  return (
    err instanceof IdempotencyConflictError ||
    err instanceof WalletNotFoundError ||
    err instanceof CurrencyMismatchOnWalletError
  );
}

export class SqsConsumer {
  private running = false;
  private stopping = false;
  private inFlight = 0;
  private loopDone?: Promise<void>;
  private readonly abort = new AbortController();

  constructor(private readonly em: EntityManager) { }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopDone = this.pollLoop();
  }

  /**
   * Para de pollar (abortando o long poll em andamento) e espera a mensagem corrente
   * terminar, até o deadline. Mensagens recebidas mas não iniciadas voltam à fila
   * quando a visibilidade expira.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    if (this.loopDone) {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_DEADLINE_MS); });
      await Promise.race([this.loopDone, deadline]);
      if (timer) clearTimeout(timer);
    }
    this.running = false;
  }

  private async pollLoop(): Promise<void> {
    while (this.running && !this.stopping) {
      try {
        const res = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: QUEUE_URLS.transactions,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
            VisibilityTimeout: 30,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
          { abortSignal: this.abort.signal },
        );

        for (const msg of res.Messages ?? []) {
          if (this.stopping) break;
          this.inFlight++;
          try {
            await this.handleMessage(msg);
          } finally {
            this.inFlight--;
          }
        }
      } catch (err) {
        if (this.stopping) break;
        console.error(JSON.stringify({
          level: 'error', worker: 'sqs-consumer', error: String(err),
        }));
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async handleMessage(msg: Message): Promise<void> {
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? '1');

    let parsed: any;
    try {
      parsed = JSON.parse(msg.Body ?? '');
    } catch {
      await this.deadLetter(msg, 'INVALID_JSON');
      return;
    }

    if (parsed?.type !== 'WagerTransactionRequested' || !parsed.data) {
      // Filtro defensivo: evento que não é request (ex.: fila errada) é descartado.
      await this.delete(msg);
      console.log(JSON.stringify({
        level: 'warn', worker: 'sqs-consumer', messageId: msg.MessageId,
        type: parsed?.type, outcome: 'ack-unexpected-type',
      }));
      return;
    }

    const messageId: string = typeof parsed.messageId === 'string' && parsed.messageId
      ? parsed.messageId
      : (msg.MessageId ?? '');

    try {
      const req = validateWagerRequest(parsed.data);
      const idempotencyKey: string =
        typeof parsed.data.idempotencyKey === 'string' && parsed.data.idempotencyKey
          ? parsed.data.idempotencyKey
          : `${req.providerId}:${req.externalTransactionId}`;

      const uc = new ProcessWagerTransactionUseCase(this.em);
      await uc.execute({
        ...req,
        idempotencyKey,
        consumerName: CONSUMER_NAME,
        messageId,
        correlationId: messageId,
      });

      // Ack só depois do commit do use case.
      await this.delete(msg);
      console.log(JSON.stringify({
        level: 'info', worker: 'sqs-consumer', messageId,
        externalTransactionId: req.externalTransactionId,
        walletId: req.walletId, kind: req.kind, outcome: 'ack',
      }));
    } catch (err) {
      if (isPermanentError(err)) {
        await this.deadLetter(msg, `PERMANENT: ${String(err)}`);
        return;
      }

      if (isTerminalBusinessError(err)) {
        await this.delete(msg);
        console.log(JSON.stringify({
          level: 'warn', worker: 'sqs-consumer', messageId,
          error: String(err), outcome: 'ack-terminal',
        }));
        return;
      }

      if (receiveCount >= MAX_RECEIVE_COUNT) {
        console.error(JSON.stringify({
          level: 'error', worker: 'sqs-consumer', messageId,
          receiveCount, error: String(err), outcome: 'dlq',
        }));
        await this.deadLetter(msg, String(err));
        return;
      }

      // Transitório: não faz ack; a mensagem volta quando a visibilidade expirar.
      console.error(JSON.stringify({
        level: 'warn', worker: 'sqs-consumer', messageId,
        receiveCount, error: String(err), outcome: 'retry',
      }));
    }
  }

  /**
   * Envia para a DLQ e só então apaga da fila de origem. Se o envio falhar, a mensagem
   * NÃO é apagada (volta por visibilidade e a redrive policy da fila a move depois).
   */
  private async deadLetter(msg: Message, reason: string): Promise<void> {
    try {
      await sqs.send(new SendMessageCommand({
        QueueUrl: QUEUE_URLS.dlq,
        MessageBody: msg.Body ?? '',
        MessageGroupId: 'dlq',
        MessageDeduplicationId: `${msg.MessageId}-${Date.now()}`,
        MessageAttributes: {
          reason: { DataType: 'String', StringValue: reason.slice(0, 250) },
          originalMessageId: { DataType: 'String', StringValue: msg.MessageId ?? '' },
        },
      }));
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error', worker: 'sqs-consumer', phase: 'dlq-send',
        messageId: msg.MessageId, error: String(err), outcome: 'kept-in-queue',
      }));
      return;
    }
    await this.delete(msg);
  }

  private async delete(msg: Message): Promise<void> {
    if (!msg.ReceiptHandle) return;
    await sqs.send(new DeleteMessageCommand({
      QueueUrl: QUEUE_URLS.transactions,
      ReceiptHandle: msg.ReceiptHandle,
    }));
  }
}
