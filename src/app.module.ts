import { Module, OnApplicationBootstrap, OnApplicationShutdown, Global } from '@nestjs/common';
import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from './mikro-orm.config';
import { WalletsController } from './api/wallets.controller';
import { WageringController } from './api/wagering.controller';
import { HealthController } from './api/health.controller';
import { AuthGuard } from './api/auth.guard';
import { OutboxPublisherWorker } from './application/outbox-publisher.worker';
import { PendingReferenceWorker } from './application/pending-reference.worker';
import { SqsConsumer } from './infrastructure/messaging/sqs-consumer';

@Global()
@Module({
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    AuthGuard,
    {
      provide: MikroORM,
      useFactory: async () => MikroORM.init(config),
    },
    {
      provide: EntityManager,
      useFactory: (orm: MikroORM) => orm.em.fork(),
      inject: [MikroORM],
    },
  ],
  exports: [MikroORM, EntityManager],
})
export class AppModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private outboxWorker?: OutboxPublisherWorker;
  private sqsConsumer?: SqsConsumer;
  private pendingWorker?: PendingReferenceWorker;

  constructor(private readonly orm: MikroORM) {}

  async onApplicationBootstrap() {
    this.outboxWorker = new OutboxPublisherWorker(this.orm.em.fork(), 1000, 10);
    this.outboxWorker.start();

    this.sqsConsumer = new SqsConsumer(this.orm.em.fork());
    this.sqsConsumer.start();

    this.pendingWorker = new PendingReferenceWorker(this.orm.em.fork());
    this.pendingWorker.start();

    console.log(JSON.stringify({ level: 'info', message: 'workers started' }));
  }

  async onApplicationShutdown() {
    const shutdowns = [
      this.sqsConsumer?.stop(),
      this.outboxWorker?.stop(),
      this.pendingWorker?.stop(),
    ].filter((p): p is Promise<void> => p !== undefined);
    await Promise.all(shutdowns);
    await this.orm.close(true);
    console.log(JSON.stringify({ level: 'info', message: 'graceful shutdown complete' }));
  }
}
