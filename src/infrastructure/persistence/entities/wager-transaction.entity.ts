import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wager_transaction' })
@Unique({ properties: ['providerId', 'externalTransactionId'] })
@Unique({ properties: ['idempotencyKey'] })
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'provider_id', type: 'varchar', length: 64 })
  providerId!: string;

  @Property({ fieldName: 'external_transaction_id', type: 'varchar', length: 128 })
  externalTransactionId!: string;

  @Property({ fieldName: 'idempotency_key', type: 'varchar', length: 256 })
  idempotencyKey!: string;

  @Property({ fieldName: 'payload_hash', type: 'char', length: 64 })
  payloadHash!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ fieldName: 'round_id', type: 'varchar', length: 128 })
  roundId!: string;

  @Property({ fieldName: 'game_id', type: 'varchar', length: 128 })
  gameId!: string;

  @Property({ type: 'varchar', length: 16 })
  kind!: string;

  @Property({ type: 'numeric', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'char', length: 3 })
  currency!: string;

  @Property({
    fieldName: 'reference_external_transaction_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  referenceExternalTransactionId?: string;

  @Property({
    fieldName: 'reference_transaction_id',
    type: 'uuid',
    nullable: true,
  })
  referenceTransactionId?: string;

  @Property({ type: 'varchar', length: 32 })
  status!: string;

  @Property({ fieldName: 'failure_code', type: 'varchar', length: 64, nullable: true })
  failureCode?: string;

  @Property({ fieldName: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Property({ fieldName: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date;
}
