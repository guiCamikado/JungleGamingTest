/**
 * Preload dos testes de integração: aplica as migrations pendentes no Postgres
 * (docker compose up) antes de qualquer teste, usando o mesmo CLI do `bun run migration:up`.
 */
const proc = Bun.spawnSync(['bunx', '--bun', 'mikro-orm', 'migration:up'], {
  stdout: 'inherit',
  stderr: 'inherit',
});
if (proc.exitCode !== 0) {
  throw new Error('migration:up failed — is Postgres running? (docker compose up -d)');
}
