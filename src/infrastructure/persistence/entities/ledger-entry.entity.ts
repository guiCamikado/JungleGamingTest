import { Entity, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'wallet_ledger_entry' })
@Unique({ properties: ['walletId', 'transactionId'] })
export class LedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'transaction_id', type: 'uuid' })
  transactionId!: string;

  @Property({ type: 'varchar', length: 8 })
  direction!: 'DEBIT' | 'CREDIT';

  @Property({ type: 'numeric', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'char', length: 3 })
  currency!: string;

  @Property({ fieldName: 'balance_before_amount', type: 'numeric', precision: 20, scale: 2 })
  balanceBeforeAmount!: string;

  @Property({ fieldName: 'balance_before_currency', type: 'char', length: 3 })
  balanceBeforeCurrency!: string;

  @Property({ fieldName: 'balance_after_amount', type: 'numeric', precision: 20, scale: 2 })
  balanceAfterAmount!: string;

  @Property({ fieldName: 'balance_after_currency', type: 'char', length: 3 })
  balanceAfterCurrency!: string;

  @Property({ fieldName: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
