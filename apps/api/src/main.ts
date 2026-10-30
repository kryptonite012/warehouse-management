import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'fs';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function main() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false, rawBody: true });
  const doc = configureApp(app, { swagger: true });
  if (process.env.OPENAPI_OUT && doc) {
    writeFileSync(process.env.OPENAPI_OUT, JSON.stringify(doc, null, 2));
    Logger.log(`OpenAPI spec written to ${process.env.OPENAPI_OUT}`);
    await app.close();
    return;
  }
  app.enableShutdownHooks();
  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`QuickStore API listening on :${port}`);
}

main();
