import { Entity, PrimaryKey, Property, Index } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_message' })
@Index({ properties: ['publishedAt', 'nextAttemptAt'] })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Property({ fieldName: 'event_type', type: 'varchar', length: 128 })
  eventType!: string;

  @Property({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ fieldName: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Property({ type: 'int', default: 0 })
  attempts!: number;

  @Property({ fieldName: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt?: Date;

  @Property({ fieldName: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt?: Date;
}
