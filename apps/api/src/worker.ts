import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { hostname } from 'os';
import { AppModule } from './app.module';
import { PrismaService } from './common/prisma.service';
import { InventoryService } from './modules/inventory/inventory.service';
import { ReservationService } from './modules/inventory/reservation.service';
import { OrdersService } from './modules/orders/orders.service';

interface Job {
  name: string;
  everySeconds: number;
  run: () => Promise<unknown>;
}

const logger = new Logger('Worker');
const workerId = `${hostname()}:${process.pid}`;

/** Acquire a time-bounded lease; returns false if another replica holds it. */
async function lease(prisma: PrismaService, name: string, seconds: number) {
  const rows = await prisma.$executeRaw`
    INSERT INTO job_leases (name, locked_until, locked_by) VALUES (${name}, now() + make_interval(secs => ${seconds}), ${workerId})
    ON CONFLICT (name) DO UPDATE SET locked_until = EXCLUDED.locked_until, locked_by = EXCLUDED.locked_by
    WHERE job_leases.locked_until < now()`;
  return rows === 1;
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  const prisma = app.get(PrismaService);
  const reservations = app.get(ReservationService);
  const inventory = app.get(InventoryService);
  const orders = app.get(OrdersService);

  const jobs: Job[] = [
    { name: 'orders.cancel_unpaid', everySeconds: 60, run: () => orders.cancelStaleUnpaid() },
    { name: 'reservations.expire', everySeconds: 60, run: () => reservations.expireDue() },
    { name: 'inventory.expiry_sweep', everySeconds: 3600, run: () => inventory.sweepExpiredBatches() },
    { name: 'inventory.low_stock_alerts', everySeconds: 900, run: () => inventory.raiseLowStockAlerts() },
  ];

  let stopping = false;
  process.on('SIGTERM', () => (stopping = true));
  process.on('SIGINT', () => (stopping = true));
  logger.log(`worker ${workerId} started with ${jobs.length} jobs`);

  while (!stopping) {
    for (const job of jobs) {
      if (stopping) break;
      try {
        if (!(await lease(prisma, job.name, job.everySeconds))) continue;
        const started = Date.now();
        const result = await job.run();
        await prisma.jobLease.update({ where: { name: job.name }, data: { lastRunAt: new Date(), lastResult: (result ?? {}) as any } });
        logger.log(`${job.name} done in ${Date.now() - started}ms ${JSON.stringify(result)}`);
      } catch (e) {
        logger.error(`${job.name} failed: ${(e as Error).message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  await app.close();
}

if (require.main === module) main();
