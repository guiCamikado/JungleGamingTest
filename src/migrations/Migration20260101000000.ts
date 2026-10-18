import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallet (
        id uuid PRIMARY KEY,
        player_id uuid NOT NULL,
        currency char(3) NOT NULL,
        balance_amount numeric(20,2) NOT NULL,
        balance_currency char(3) NOT NULL,
        version int NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        CONSTRAINT wallet_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallet_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT wallet_currency_match CHECK (currency = balance_currency),
        CONSTRAINT wallet_version_positive CHECK (version >= 1)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transaction (
        id uuid PRIMARY KEY,
        provider_id varchar(64) NOT NULL,
        external_transaction_id varchar(128) NOT NULL,
        idempotency_key varchar(256) NOT NULL,
        payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES wallet(id),
        player_id uuid NOT NULL,
        round_id varchar(128) NOT NULL,
        game_id varchar(128) NOT NULL,
        kind varchar(16) NOT NULL,
        amount numeric(20,2) NOT NULL,
        currency char(3) NOT NULL,
        reference_external_transaction_id varchar(128) NULL,
        reference_transaction_id uuid NULL,
        status varchar(32) NOT NULL,
        failure_code varchar(64) NULL,
        created_at timestamptz NOT NULL,
        processed_at timestamptz NULL,
        CONSTRAINT wager_provider_external_unique UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_idempotency_unique UNIQUE (idempotency_key),
        CONSTRAINT wager_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT wager_kind_valid CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_status_valid CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'))
      );
    `);
    this.addSql(`CREATE INDEX wager_pending_reference_idx ON wager_transaction (status) WHERE status = 'PENDING_REFERENCE';`);

    this.addSql(`
      CREATE TABLE wallet_ledger_entry (
        id uuid PRIMARY KEY,
        wallet_id uuid NOT NULL REFERENCES wallet(id),
        transaction_id uuid NOT NULL REFERENCES wager_transaction(id),
        direction varchar(8) NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount numeric(20,2) NOT NULL CHECK (amount > 0),
        currency char(3) NOT NULL,
        balance_before_amount numeric(20,2) NOT NULL,
        balance_before_currency char(3) NOT NULL,
        balance_after_amount numeric(20,2) NOT NULL,
        balance_after_currency char(3) NOT NULL,
        created_at timestamptz NOT NULL,
        CONSTRAINT ledger_one_per_wallet_tx UNIQUE (wallet_id, transaction_id)
      );
    `);
    this.addSql(`CREATE INDEX ledger_wallet_created_idx ON wallet_ledger_entry (wallet_id, created_at, id);`);

    // Imutabilidade estrutural do ledger: trigger que bloqueia UPDATE/DELETE
    this.addSql(`
      CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entry is immutable';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_update BEFORE UPDATE ON wallet_ledger_entry
        FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
      CREATE TRIGGER ledger_no_delete BEFORE DELETE ON wallet_ledger_entry
        FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
    `);

    this.addSql(`
      CREATE TABLE inbox_message (
        id uuid PRIMARY KEY,
        message_id varchar(128) NOT NULL,
        consumer_name varchar(128) NOT NULL,
        payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL,
        processed_at timestamptz NULL,
        CONSTRAINT inbox_unique UNIQUE (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_message (
        id uuid PRIMARY KEY,
        aggregate_id uuid NOT NULL,
        event_type varchar(128) NOT NULL,
        payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL,
        attempts int NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NULL,
        published_at timestamptz NULL
      );
    `);
    this.addSql(`CREATE INDEX outbox_pending_idx ON outbox_message (published_at, next_attempt_at) WHERE published_at IS NULL;`);
  }

  async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS outbox_message;`);
    this.addSql(`DROP TABLE IF EXISTS inbox_message;`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entry;`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_immutable();`);
    this.addSql(`DROP TABLE IF EXISTS wager_transaction;`);
    this.addSql(`DROP TABLE IF EXISTS wallet;`);
  }
}
