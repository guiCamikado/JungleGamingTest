import { SQSClient } from '@aws-sdk/client-sqs';

export const sqs = new SQSClient({
  endpoint: 'http://127.0.0.1:4566',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

export const QUEUE_URLS = {
  transactions: 'http://127.0.0.1:4566/000000000000/wager-transactions.fifo',
  events: 'http://127.0.0.1:4566/000000000000/wager-events.fifo',
  dlq: 'http://127.0.0.1:4566/000000000000/wager-transactions-dlq.fifo',
} as const;
