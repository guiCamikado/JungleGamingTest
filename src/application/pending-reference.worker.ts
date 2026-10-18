import { EntityManager } from '@mikro-orm/postgresql';

export class PendingReferenceWorker {
  constructor(private readonly em: EntityManager) {}

  start(): void {
    console.log(JSON.stringify({ level: 'info', worker: 'pending-reference', message: 'stub started' }));
  }

  async stop(): Promise<void> {}
}
