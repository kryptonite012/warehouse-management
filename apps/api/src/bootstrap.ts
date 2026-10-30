import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

/** Shared app configuration used by main.ts and the e2e tests. */
export function configureApp(app: INestApplication, opts: { swagger?: boolean } = {}) {
  app.setGlobalPrefix(process.env.API_PREFIX?.replace(/^\//, '') ?? 'api/v1', {
    exclude: ['metrics', 'health/live', 'health/ready'],
  });
  app.use(helmet());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
    credentials: false,
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  (app as any).set?.('trust proxy', 1);

  if (opts.swagger) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('QuickStore API')
        .setDescription('Quick-commerce operating platform: warehouses, dark stores, inventory ledger, procurement, orders, fulfilment, delivery.')
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('api/docs', app, doc);
    return doc;
  }
}
