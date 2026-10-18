import { defineConfig } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { config } from './config';

export default defineConfig({
  metadataProvider: ReflectMetadataProvider,
  entities: ['./dist/infrastructure/persistence/entities'],
  entitiesTs: ['./src/infrastructure/persistence/entities/*.entity.ts'],
  dbName: config.db.dbName,
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  // Schema gerenciado exclusivamente por migrations versionadas
  // (`migration:create` + `migration:up`), nunca pelo schema generator.
  migrations: {
    path: './src/migrations',
    pathTs: './src/migrations',
    transactional: true,
  },
  discovery: { warnWhenNoEntities: false },
});
