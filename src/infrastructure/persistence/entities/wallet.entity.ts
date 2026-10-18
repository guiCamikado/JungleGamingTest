import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallet' })
@Unique({ properties: ['playerId', 'currency'] })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ type: 'char', length: 3 })
  currency!: string;

  // numeric(20,2) — nunca number/float
  @Property({ fieldName: 'balance_amount', type: 'numeric', precision: 20, scale: 2 })
  balanceAmount!: string;

  @Property({ fieldName: 'balance_currency', type: 'char', length: 3 })
  balanceCurrency!: string;

  @Property({ fieldName: 'version', type: 'int' })
  version!: number;

  @Property({ fieldName: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Property({ fieldName: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
