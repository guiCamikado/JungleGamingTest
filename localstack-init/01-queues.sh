#!/bin/bash
# Executado pelo LocalStack quando fica "ready" (montado em /etc/localstack/init/ready.d).
set -euo pipefail

ACCOUNT=000000000000
REGION=us-east-1

# Dead-letter queue
awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true

# Entrada: requests de transação (com redrive para a DLQ após 5 recebimentos)
awslocal sqs create-queue --queue-name wager-transactions.fifo \
  --attributes "{\"FifoQueue\":\"true\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"arn:aws:sqs:${REGION}:${ACCOUNT}:wager-transactions-dlq.fifo\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

# Saída: eventos publicados pelo outbox
awslocal sqs create-queue --queue-name wager-events.fifo \
  --attributes FifoQueue=true
