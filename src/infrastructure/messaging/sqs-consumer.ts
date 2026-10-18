import { EntityManager } from '@mikro-orm/postgresql';
import {
  ReceiveMessageCommand, DeleteMessageCommand, SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { Money } from '../../domain/money';
import { WagerTransactionKind } from '../../domain/wager-transaction';
import {
  ProcessWagerTransactionUseCase,
  IdempotencyConflictError,
  WalletNotFoundError,
  CurrencyMismatchOnWalletError,
} from '../../application/process-wager-transaction.use-case';
import { sqs, QUEUE_URLS } from './sqs.client';

interface WagerMessageData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

interface WagerMessage {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: WagerMessageData;
}

const CONSUMER_NAME = 'wager-transactions-consumer';
const MAX_RECEIVE_COUNT = 5;

export class SqsConsumer {
  private running = false;
  private stopping = false;
  private inFlight = 0;

  constructor(private readonly em: EntityManager) { }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pollLoop();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const deadline = Date.now() + 25_000;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.running = false;
  }

  private async pollLoop(): Promise<void> {
    while (this.running && !this.stopping) {
      try {
        const res = await sqs.send(new ReceiveMessageCommand({
          QueueUrl: QUEUE_URLS.transactions,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 30,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }));

        if (!res.Messages || res.Messages.length === 0) continue;

        for (const msg of res.Messages) {
          this.inFlight++;
          try {
            await this.handleMessage(msg);
          } finally {
            this.inFlight--;
          }
        }
      } catch (err) {
        console.error(JSON.stringify({
          level: 'error', worker: 'sqs-consumer', error: String(err),
        }));
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async handleMessage(msg: Message): Promise<void> {
    const receiveCount = Number(msg.Attributes?.ApproximateReceiveCount ?? '1');

    let parsed: WagerMessage;
    try {
      parsed = JSON.parse(msg.Body ?? '');
    } catch {
      await this.sendToDlq(msg, 'INVALID_JSON');
      await this.delete(msg);
      return;
    }

    try {
      if (parsed?.type !== 'WagerTransactionRequested' || !parsed.data || !parsed.data.money) {
        await this.delete(msg);
        console.log(JSON.stringify({
          level: 'warn', worker: 'sqs-consumer',
          messageId: msg.MessageId,
          type: parsed?.type,
          outcome: 'ack-unexpected-type',
        }));
        return;
      }
      const money = Money.from(parsed.data.money);
      const uc = new ProcessWagerTransactionUseCase(this.em);
      await uc.execute({
        providerId: parsed.data.providerId,
        externalTransactionId: parsed.data.externalTransactionId,
        idempotencyKey: parsed.data.idempotencyKey,
        playerId: parsed.data.playerId,
        walletId: parsed.data.walletId,
        roundId: parsed.data.roundId,
        gameId: parsed.data.gameId,
        kind: parsed.data.kind as WagerTransactionKind,
        money,
        referenceExternalTransactionId: parsed.data.referenceExternalTransactionId,
        consumerName: CONSUMER_NAME,
        messageId: parsed.messageId,
        correlationId: parsed.messageId,
      });

      await this.delete(msg);

      console.log(JSON.stringify({
        level: 'info', worker: 'sqs-consumer',
        messageId: parsed.messageId,
        externalTransactionId: parsed.data.externalTransactionId,
        walletId: parsed.data.walletId,
        kind: parsed.data.kind,
        outcome: 'ack',
      }));
    } catch (err) {
      if (err instanceof IdempotencyConflictError || err instanceof WalletNotFoundError || err instanceof CurrencyMismatchOnWalletError) {
        await this.delete(msg);
        console.log(JSON.stringify({
          level: 'warn', worker: 'sqs-consumer',
          messageId: parsed.messageId, error: String(err), outcome: 'ack-terminal',
        }));
        return;
      }

      if (receiveCount >= MAX_RECEIVE_COUNT) {
        await this.sendToDlq(msg, String(err));
        await this.delete(msg);
        console.error(JSON.stringify({
          level: 'error', worker: 'sqs-consumer', messageId: parsed.messageId,
          receiveCount, error: String(err), outcome: 'dlq',
        }));
        return;
      }

      console.error(JSON.stringify({
        level: 'warn', worker: 'sqs-consumer', messageId: parsed.messageId,
        receiveCount, error: String(err), outcome: 'retry',
      }));
    }
  }

  private async delete(msg: Message): Promise<void> {
    if (!msg.ReceiptHandle) return;
    await sqs.send(new DeleteMessageCommand({
      QueueUrl: QUEUE_URLS.transactions,
      ReceiptHandle: msg.ReceiptHandle,
    }));
  }

  private async sendToDlq(msg: Message, reason: string): Promise<void> {
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
        messageId: msg.MessageId, error: String(err),
      }));
    }
  }
}
