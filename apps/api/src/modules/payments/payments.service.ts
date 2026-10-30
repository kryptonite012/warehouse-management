import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { AuthContext, SYSTEM_ACTOR } from '../../common/auth-context';
import { Conflict, DomainError, NotFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { businessCounter } from '../../metrics';
import { ReservationService } from '../inventory/reservation.service';
import { OrderStateService } from '../orders/order-state.service';
import { PaymentGateway, WebhookEvent } from './gateway';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('Payments');

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGateway,
    private readonly state: OrderStateService,
    private readonly reservations: ReservationService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Webhook entry point. Order of checks:
   *  1. signature over the raw body (forged callbacks never reach business logic)
   *  2. event stored under UNIQUE(provider, provider_event_id) => duplicates are no-ops
   *  3. amount must match the payment we created
   *  4. payment status compare-and-set, then order transition, in one transaction
   */
  async handleWebhook(providerName: string, rawBody: Buffer | undefined, signature: string | undefined, body: any) {
    const provider = this.gateway.provider;
    if (!provider || provider.name !== providerName) throw new DomainError('PAYMENT_NOT_CONFIGURED', 'Unknown payment provider', 404);
    if (!rawBody || !provider.verifySignature(rawBody, signature)) {
      await this.prisma.securityEvent.create({ data: { eventType: 'PAYMENT_SIGNATURE_INVALID', severity: 'HIGH', details: { provider: providerName } } });
      throw new UnauthorizedException('Invalid webhook signature');
    }
    let event: WebhookEvent;
    try {
      event = provider.parseEvent(body);
    } catch {
      throw new BadRequestException('Malformed event');
    }
    if (!event.eventId || !event.paymentId || !/^[0-9a-f-]{36}$/i.test(event.paymentId)) throw new BadRequestException('Malformed event');

    return this.prisma.withRetry(async (tx) => {
      const inserted = await tx.$executeRaw`
        INSERT INTO payment_events (id, payment_id, provider, provider_event_id, event_type, payload, signature_valid, created_at)
        VALUES (gen_random_uuid(), ${event.paymentId}::uuid, ${providerName}, ${event.eventId}, ${event.type}, ${JSON.stringify(body)}::jsonb, true, now())
        ON CONFLICT (provider, provider_event_id) DO NOTHING`;
      if (!inserted) return { status: 'duplicate', eventId: event.eventId };

      const payment = await tx.payment.findUnique({ where: { id: event.paymentId }, include: { order: true } });
      if (!payment) throw NotFound('Payment', event.paymentId);
      if (Math.abs(Number(payment.amount) - event.amount) > 0.001) {
        await tx.securityEvent.create({ data: { eventType: 'PAYMENT_AMOUNT_MISMATCH', severity: 'HIGH', details: { paymentId: payment.id, expected: Number(payment.amount), received: event.amount } } });
        throw new DomainError('AMOUNT_MISMATCH', 'Callback amount does not match the payment', 422);
      }
      const sys = SYSTEM_ACTOR(payment.organizationId);
      let outcome = 'ignored';

      if (event.type === 'payment.captured') {
        const { count } = await tx.payment.updateMany({
          where: { id: payment.id, status: { in: ['INITIATED', 'PENDING', 'FAILED'] } },
          data: { status: 'CAPTURED', capturedAt: new Date(), providerPaymentId: event.providerPaymentId, failureReason: null },
        });
        if (count) {
          outcome = 'captured';
          const order = payment.order;
          if (order.status === 'PAYMENT_PENDING' || order.status === 'PAYMENT_FAILED') {
            if (order.status === 'PAYMENT_FAILED') await this.state.transition(tx, order.id, 'PAYMENT_PENDING', sys, 'payment.retry');
            await this.state.transition(tx, order.id, 'PAYMENT_CONFIRMED', sys, 'payment.captured');
            const res = order.reservationId ? await tx.inventoryReservation.findUnique({ where: { id: order.reservationId } }) : null;
            if (res?.status === 'ACTIVE') {
              await this.reservations.extend(tx, res.id, 24 * 60);
              await this.state.transition(tx, order.id, 'INVENTORY_RESERVED', sys, 'inventory.confirmed');
              await this.state.transition(tx, order.id, 'ACCEPTED', sys, 'store.auto_accepted');
            } else {
              // Paid after the hold expired: never ship unreserved stock; refund instead.
              await this.state.transition(tx, order.id, 'CANCELLED', sys, 'inventory.expired', 'payment arrived after reservation expired');
              await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUND_PENDING' } });
              await tx.refund.create({ data: { paymentId: payment.id, amount: payment.amount, reason: 'paid after reservation expired' } });
              await this.state.transition(tx, order.id, 'REFUND_PENDING', sys, 'refund.created');
              outcome = 'captured_late_refunding';
            }
          } else if (order.status === 'CANCELLED') {
            await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUND_PENDING' } });
            await tx.refund.create({ data: { paymentId: payment.id, amount: payment.amount, reason: 'payment captured for cancelled order' } });
            await this.state.transition(tx, order.id, 'REFUND_PENDING', sys, 'refund.created');
            outcome = 'captured_cancelled_refunding';
          }
          businessCounter.inc({ event: 'payment_captured' });
        }
      } else if (event.type === 'payment.failed') {
        const { count } = await tx.payment.updateMany({
          where: { id: payment.id, status: { in: ['INITIATED', 'PENDING'] } },
          data: { status: 'FAILED', failureReason: event.failureReason ?? 'failed' },
        });
        if (count && payment.order.status === 'PAYMENT_PENDING') {
          await this.state.transition(tx, payment.orderId, 'PAYMENT_FAILED', sys, 'payment.failed', event.failureReason);
          outcome = 'failed';
        }
      } else if (event.type === 'refund.processed') {
        outcome = (await this.completeRefundInTx(tx, payment.id, event.providerPaymentId ?? event.eventId, sys)) ? 'refunded' : 'ignored';
      }

      await tx.paymentEvent.updateMany({ where: { provider: providerName, providerEventId: event.eventId }, data: { processedAt: new Date() } });
      return { status: 'processed', outcome, eventId: event.eventId };
    });
  }

  /** Manual refund completion (COD / bank transfer refunds) by finance staff. */
  async completeRefund(actor: AuthContext, refundId: string, reference: string) {
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
    if (!refund || refund.payment.organizationId !== actor.organizationId) throw NotFound('Refund', refundId);
    if (refund.status !== 'PENDING') throw Conflict('REFUND_NOT_PENDING', `Refund is ${refund.status}`);
    return this.prisma.withRetry(async (tx) => {
      await this.completeRefundInTx(tx, refund.paymentId, reference, actor, refundId);
      await this.audit.record({ actor, action: 'refund.complete', resourceType: 'refund', resourceId: refundId, after: { reference } }, tx);
      return tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    });
  }

  private async completeRefundInTx(tx: Prisma.TransactionClient, paymentId: string, reference: string, actor: AuthContext, refundId?: string) {
    const { count } = await tx.refund.updateMany({
      where: { paymentId, status: 'PENDING', ...(refundId ? { id: refundId } : {}) },
      data: { status: 'COMPLETED', providerRefundId: reference },
    });
    if (!count) return false;
    const remaining = await tx.refund.count({ where: { paymentId, status: 'PENDING' } });
    if (!remaining) {
      const p = await tx.payment.update({ where: { id: paymentId }, data: { status: 'REFUNDED' } });
      const order = await tx.order.findUniqueOrThrow({ where: { id: p.orderId } });
      if (order.status === 'REFUND_PENDING') await this.state.transition(tx, order.id, 'REFUNDED', actor, 'refund.completed');
    }
    return true;
  }

  /** COD cash collected at the doorstep, recorded by the rider app. */
  async markCodCollected(tx: Prisma.TransactionClient, orderId: string) {
    await tx.payment.updateMany({ where: { orderId, method: 'COD', status: 'COD_PENDING' }, data: { status: 'COD_COLLECTED', capturedAt: new Date() } });
  }

  list(actor: AuthContext, status?: string) {
    return this.prisma.payment.findMany({
      where: { organizationId: actor.organizationId, status: status as any },
      include: { order: { select: { orderNumber: true } }, refunds: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** Reconciliation: captured vs. collected vs. refunded per method for a date range. */
  async reconciliation(actor: AuthContext, from: Date, to: Date) {
    return this.prisma.$queryRaw`
      SELECT method, status, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::float AS amount
      FROM payments WHERE organization_id = ${actor.organizationId}::uuid AND created_at >= ${from} AND created_at < ${to}
      GROUP BY method, status ORDER BY method, status`;
  }
}
