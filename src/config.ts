/**
 * Configuração centralizada, lida de variáveis de ambiente.
 * Os defaults servem para o ambiente local do docker-compose.
 */
const env = (key: string, fallback: string): string => process.env[key] ?? fallback;

const sqsEndpoint = env('SQS_ENDPOINT', 'http://localhost:4566');
const sqsAccountId = env('SQS_ACCOUNT_ID', '000000000000');
const queueUrl = (name: string) => `${sqsEndpoint}/${sqsAccountId}/${name}`;

export const config = {
  port: Number(env('PORT', '3000')),
  db: {
    host: env('DB_HOST', 'localhost'),
    port: Number(env('DB_PORT', '5432')),
    user: env('DB_USER', 'jungle'),
    password: env('DB_PASSWORD', 'jungle'),
    dbName: env('DB_NAME', 'wagering'),
  },
  sqs: {
    endpoint: sqsEndpoint,
    region: env('AWS_REGION', 'us-east-1'),
    credentials: {
      accessKeyId: env('AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: env('AWS_SECRET_ACCESS_KEY', 'test'),
    },
    queues: {
      transactions: env('SQS_TRANSACTIONS_QUEUE_URL', queueUrl('wager-transactions.fifo')),
      events: env('SQS_EVENTS_QUEUE_URL', queueUrl('wager-events.fifo')),
      dlq: env('SQS_DLQ_URL', queueUrl('wager-transactions-dlq.fifo')),
    },
  },
} as const;
