import { Controller, Get, Header, Injectable, NestMiddleware, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { NextFunction, Request, Response } from 'express';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
import { Public } from './common/decorators';
import { PrismaService } from './common/prisma.service';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'quickstore_' });

const httpDuration = new Histogram({
  name: 'quickstore_http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const businessCounter = new Counter({
  name: 'quickstore_business_events_total',
  help: 'Business events (orders placed, reservations failed, ...)',
  labelNames: ['event'],
  registers: [registry],
});

@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      const route = (req as any).route?.path ?? 'unmatched';
      end({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  }
}

@ApiExcludeController()
@Controller()
export class OpsController {
  constructor(private readonly prisma: PrismaService) {}

  @Public() @Get('metrics') @Header('Content-Type', registry.contentType)
  metrics() {
    return registry.metrics();
  }

  @Public() @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: verifies the database answers. Used by Docker/Nginx health checks. */
  @Public() @Get('health/ready')
  async ready() {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ code: 'NOT_READY', message: 'database unavailable' });
    }
    return { status: 'ok', database: { status: 'up', latencyMs: Date.now() - started } };
  }
}
