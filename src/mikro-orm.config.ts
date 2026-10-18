import { defineConfig } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';

export default defineConfig({
  metadataProvider: ReflectMetadataProvider,
  entities: ['./dist/infrastructure/persistence/entities'],
  entitiesTs: ['./src/infrastructure/persistence/entities/*.entity.ts'],
  dbName: 'wagering',
  host: 'localhost',
  port: 5432,
  user: 'jungle',
  password: 'jungle',
  // Não deixe o MikroORM gerenciar schema — o desafio exige migrations versionadas
  // Você vai usar `migration:create` + `migration:up`
  migrations: {
    path: './src/migrations',
    pathTs: './src/migrations',
    transactional: true,
  },
  // Desabilita o schema generator automático
  discovery: { warnWhenNoEntities: false },
});