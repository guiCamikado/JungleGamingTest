mkdir localstack-init
cat > localstack-init/01-queues.sh << 'EOF'
#!/bin/bash
awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes FifoQueue=true,RedrivePolicy='{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo","maxReceiveCount":"5"}'
EOF
chmod +x localstack-init/01-queues.sh