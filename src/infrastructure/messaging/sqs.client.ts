import { SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../../config';

export const sqs = new SQSClient({
  endpoint: config.sqs.endpoint,
  region: config.sqs.region,
  credentials: config.sqs.credentials,
});

export const QUEUE_URLS = config.sqs.queues;
