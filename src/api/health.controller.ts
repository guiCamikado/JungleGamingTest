import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { ListQueuesCommand } from '@aws-sdk/client-sqs';
import { sqs } from '../infrastructure/messaging/sqs.client';

@Controller('health')
export class HealthController {
  constructor(private readonly em: EntityManager) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    const checks: Record<string, string> = {};
    let ok = true;

    try {
      await this.em.execute('SELECT 1');
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'down';
      ok = false;
    }

    try {
      await sqs.send(new ListQueuesCommand({}));
      checks.sqs = 'ok';
    } catch {
      checks.sqs = 'down';
      ok = false;
    }

    if (!ok) throw new ServiceUnavailableException(checks);
    return { status: 'ready', checks };
  }
}
