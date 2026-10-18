import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'inbox_message' })
@Unique({ properties: ['consumerName', 'messageId'] })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'message_id', type: 'varchar', length: 128 })
  messageId!: string;

  @Property({ fieldName: 'consumer_name', type: 'varchar', length: 128 })
  consumerName!: string;

  @Property({ fieldName: 'payload_hash', type: 'char', length: 64 })
  payloadHash!: string;

  @Property({ fieldName: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;

  @Property({ fieldName: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date;
}
