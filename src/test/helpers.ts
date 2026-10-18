import { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config';

let orm: MikroORM | undefined;

export async function getOrm(): Promise<MikroORM> {
  if (!orm) orm = await MikroORM.init(config);
  return orm;
}

export async function getEm(): Promise<EntityManager> {
  return (await getOrm()).em.fork();
}

export async function resetDb(): Promise<void> {
  const em = await getEm();
  await em.getConnection().execute(`TRUNCATE wallet_ledger_entry, wager_transaction, inbox_message, outbox_message, wallet RESTART IDENTITY CASCADE`);
}

export async function closeOrm(): Promise<void> {
  if (orm) { await orm.close(true); orm = undefined; }
}
