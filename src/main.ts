import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { randomUUID } from 'node:crypto';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });

  // Sem isso o Nest não executa onApplicationShutdown em SIGTERM/SIGINT.
  app.enableShutdownHooks();

  // Correlation ID middleware
  app.use((req: any, res: any, next: any) => {
    req.correlationId = req.headers['x-correlation-id'] ?? randomUUID();
    res.setHeader('x-correlation-id', req.correlationId);
    next();
  });

  await app.listen(config.port);
  console.log(JSON.stringify({ level: 'info', message: `API listening on :${config.port}` }));
}

bootstrap();
