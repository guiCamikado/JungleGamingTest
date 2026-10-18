import { Migration } from '@mikro-orm/migrations';

/** Contador de tentativas de resolução de referência (PENDING_REFERENCE). */
export class Migration20261017000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transaction ADD COLUMN reference_attempts int NOT NULL DEFAULT 0;`);
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transaction DROP COLUMN reference_attempts;`);
  }
}
