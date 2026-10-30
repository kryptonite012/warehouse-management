import { Injectable, Logger } from '@nestjs/common';
import * as amqp from 'amqplib';
import { PrismaService, Tx } from './prisma.service';

export const EVENTS_EXCHANGE = 'quickstore.events';

/**
 * Transactional outbox. `emit` must be called with the business transaction so the
 * event exists iff the state change committed. `relay` (worker) publishes pending
 * events to RabbitMQ with publisher confirms, then marks them published.
 * Consumers must be idempotent on the `eventId` message id (at-least-once delivery).
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger('Outbox');
  private connection?: amqp.Connection;
  private channel?: amqp.ConfirmChannel;

  constructor(private readonly prisma: PrismaService) {}

  emit(tx: Tx, topic: string, aggregateId: string, payload: Record<string, unknown>) {
    return tx.outboxEvent.create({ data: { topic, aggregateId, payload: payload as any } });
  }

  get configured() {
    return !!process.env.RABBITMQ_URL;
  }

  async relay(batch = 200) {
    if (!this.configured) return { skipped: 'RABBITMQ_URL not configured', pending: await this.prisma.outboxEvent.count({ where: { publishedAt: null } }) };
    const ch = await this.ensureChannel();
    const events = await this.prisma.outboxEvent.findMany({ where: { publishedAt: null }, orderBy: { id: 'asc' }, take: batch });
    for (const e of events) {
      ch.publish(EVENTS_EXCHANGE, e.topic, Buffer.from(JSON.stringify({ eventId: String(e.id), topic: e.topic, aggregateId: e.aggregateId, occurredAt: e.createdAt, data: e.payload })), {
        persistent: true, contentType: 'application/json', messageId: String(e.id), timestamp: Math.floor(e.createdAt.getTime() / 1000),
      });
    }
    if (events.length) {
      await ch.waitForConfirms();
      await this.prisma.outboxEvent.updateMany({ where: { id: { in: events.map((e) => e.id) } }, data: { publishedAt: new Date() } });
    }
    return { published: events.length };
  }

  private async ensureChannel(): Promise<amqp.ConfirmChannel> {
    if (this.channel) return this.channel;
    const connection = await amqp.connect(process.env.RABBITMQ_URL!);
    this.connection = connection;
    connection.on('close', () => {
      this.logger.warn('RabbitMQ connection closed');
      this.channel = undefined;
      this.connection = undefined;
    });
    const channel = await connection.createConfirmChannel();
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
    this.channel = channel;
    return channel;
  }

  async onModuleDestroy() {
    await this.connection?.close().catch(() => undefined);
  }
}
