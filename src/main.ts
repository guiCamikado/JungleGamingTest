import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { randomUUID } from 'node:crypto';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });

  // Correlation ID middleware (opcional, mas bom para logs)
  app.use((req: any, res: any, next: any) => {
    req.correlationId = req.headers['x-correlation-id'] ?? randomUUID();
    res.setHeader('x-correlation-id', req.correlationId);
    next();
  });

  await app.listen(3000);
  console.log(JSON.stringify({ level: 'info', message: 'API listening on :3000' }));
}

bootstrap();
