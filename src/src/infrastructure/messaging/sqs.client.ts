import { SQSClient } from '@aws-sdk/client-sqs';

export const sqs = new SQSClient({
  endpoint: 'http://localhost:4566',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});

export const QUEUE_URLS = {
  transactions: 'http://localhost:4566/000000000000/wager-transactions.fifo',
  dlq: 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
} as const;
