import { Injectable, Logger } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { OutboxService } from '../../common/outbox.service';
import { assertWarehouseAccess, AuthContext, hasPermission, SYSTEM_ACTOR, warehouseScopeFilter } from '../../common/auth-context';
import { nextDocNumber } from '../../common/doc-number';
import { Conflict, DomainError, Forbidden, NotFound } from '../../common/errors';
import { pageArgs, toPage } from '../../common/pagination';
import { PERMISSIONS } from '../../common/permissions';
import { PrismaService, Tx } from '../../common/prisma.service';
import { businessCounter } from '../../metrics';
import { LedgerService } from '../inventory/ledger.service';
import { ReservationService } from '../inventory/reservation.service';
import { PaymentGateway } from '../payments/gateway';
import { CUSTOMER_CANCELLABLE } from './order-state';
import { OrderStateService } from './order-state.service';
import { OrderListQuery, PlaceOrderDto, ReceiveReturnDto } from './orders.dto';
import { StoreAllocationService } from './store-allocation.service';

const round2 = (n: number) => Math.round(n * 100) / 100;
const ORDER_INCLUDE = {
  items: true,
  payments: { include: { refunds: true } },
  statusHistory: { orderBy: { createdAt: 'asc' } },
} satisfies Prisma.OrderInclude;
const STAFF_CANCELLABLE: OrderStatus[] = [...CUSTOMER_CANCELLABLE, 'PICKING', 'PICKED', 'PARTIALLY_FULFILLED'];
const RETURN_WINDOW_HOURS = Number(process.env.RETURN_WINDOW_HOURS ?? 48);

@Injectable()
export class OrdersService {
  private readonly logger = new Logger('Orders');

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: OrderStateService,
    private readonly allocation: StoreAllocationService,
    private readonly reservations: ReservationService,
    private readonly ledger: LedgerService,
    private readonly gateway: PaymentGateway,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Idempotent checkout. Prices come from the database, never from the client.
   * Order row, promotion usage and inventory reservation are written in one transaction:
   * either the customer gets an order with stock held, or nothing is persisted.
   */
  async place(actor: AuthContext, dto: PlaceOrderDto) {
    const existing = await this.prisma.order.findUnique({
      where: { customerId_idempotencyKey: { customerId: actor.id, idempotencyKey: dto.idempotencyKey } },
      include: ORDER_INCLUDE,
    });
    if (existing) return { order: existing, replayed: true };

    if (dto.paymentMethod === 'COD' && !this.gateway.codEnabled) throw new DomainError('COD_DISABLED', 'Cash on delivery is not available', 422);
    if (dto.paymentMethod !== 'COD' && !this.gateway.provider) {
      throw new DomainError('PAYMENT_NOT_CONFIGURED', 'Online payments are not configured for this store. Choose cash on delivery.', 422);
    }

    const address = await this.prisma.customerAddress.findFirst({ where: { id: dto.addressId, customerId: actor.id } });
    if (!address) throw NotFound('Address', dto.addressId);

    let lines = dto.items ?? [];
    let cartId: string | undefined;
    if (!lines.length && dto.fromCart) {
      const cart = await this.prisma.cart.findFirst({ where: { customerId: actor.id, status: 'OPEN' }, include: { items: true } });
      lines = cart?.items.map((i) => ({ skuId: i.skuId, quantity: i.quantity })) ?? [];
      cartId = cart?.id;
    }
    if (!lines.length) throw new DomainError('EMPTY_ORDER', 'Order has no items', 400);
    const merged = new Map<string, number>();
    lines.forEach((l) => merged.set(l.skuId, (merged.get(l.skuId) ?? 0) + l.quantity));
    const items = [...merged].map(([skuId, quantity]) => ({ skuId, quantity }));

    const skus = await this.prisma.sku.findMany({
      where: { id: { in: items.map((i) => i.skuId) }, organizationId: actor.organizationId, status: 'ACTIVE', product: { status: 'ACTIVE' } },
      include: { product: { include: { taxCategory: true } } },
    });
    if (skus.length !== items.length) throw new DomainError('UNAVAILABLE_PRODUCT', 'One or more products are no longer sold', 422);

    const { store } = await this.allocation.select(
      actor.organizationId,
      { postalCode: address.postalCode, latitude: address.latitude === null ? null : Number(address.latitude), longitude: address.longitude === null ? null : Number(address.longitude) },
      items,
    );

    let subtotal = 0;
    let taxTotal = 0;
    const orderItems = items.map((i) => {
      const s = skus.find((k) => k.id === i.skuId)!;
      const price = Number(s.sellingPrice);
      const rate = Number(s.product.taxCategory?.ratePercent ?? 0);
      const line = round2(price * i.quantity);
      subtotal += line;
      taxTotal += round2((line * rate) / (100 + rate)); // prices are tax-inclusive
      return {
        skuId: s.id, skuCode: s.code, productName: s.variantName ? `${s.product.name} (${s.variantName})` : s.product.name,
        quantity: i.quantity, unitPrice: price, mrp: Number(s.mrp), taxRatePercent: rate, lineTotal: line,
      };
    });
    const deliveryFee = subtotal >= Number(process.env.FREE_DELIVERY_ABOVE ?? 199) ? 0 : Number(process.env.DELIVERY_FEE ?? 25);

    try {
      const order = await this.prisma.withRetry(async (tx) => {
        let discount = 0;
        if (dto.promotionCode) discount = await this.applyPromotion(tx, actor.organizationId, dto.promotionCode, subtotal);
        const order = await tx.order.create({
          data: {
            organizationId: actor.organizationId, orderNumber: await nextDocNumber(tx, 'ORD'), customerId: actor.id, darkStoreId: store.id,
            addressSnapshot: { ...address, latitude: address.latitude?.toString() ?? null, longitude: address.longitude?.toString() ?? null } as any,
            paymentMethod: dto.paymentMethod, subtotal: round2(subtotal), discountTotal: discount, taxTotal: round2(taxTotal), deliveryFee,
            total: round2(subtotal - discount + deliveryFee), promotionCode: dto.promotionCode?.toUpperCase(), idempotencyKey: dto.idempotencyKey,
            items: { create: orderItems },
            statusHistory: { create: { toStatus: 'CREATED', actorType: 'CUSTOMER', actorId: actor.id, event: 'order.placed' } },
          },
        });
        await this.outbox.emit(tx, 'order.created', order.id, {
          orderId: order.id, orderNumber: order.orderNumber, darkStoreId: store.id, customerId: actor.id, total: Number(order.total), paymentMethod: dto.paymentMethod,
        });
        const reservation = await this.reservations.reserve(tx, actor, {
          organizationId: actor.organizationId, warehouseId: store.id, orderId: order.id, idempotencyKey: `order:${order.id}`, items,
        });
        await tx.order.update({ where: { id: order.id }, data: { reservationId: reservation.id } });

        if (dto.paymentMethod === 'COD') {
          await tx.payment.create({ data: { organizationId: actor.organizationId, orderId: order.id, method: 'COD', provider: 'cod', amount: order.total, status: 'COD_PENDING' } });
          await this.reservations.extend(tx, reservation.id, 24 * 60);
          await this.state.transition(tx, order.id, 'INVENTORY_RESERVED', actor, 'order.cod_confirmed');
          await this.state.transition(tx, order.id, 'ACCEPTED', SYSTEM_ACTOR(actor.organizationId), 'store.auto_accepted');
        } else {
          await tx.payment.create({
            data: { organizationId: actor.organizationId, orderId: order.id, method: dto.paymentMethod, provider: this.gateway.provider!.name, amount: order.total, status: 'PENDING' },
          });
          await this.state.transition(tx, order.id, 'PAYMENT_PENDING', actor, 'payment.initiated');
        }
        if (cartId) await tx.cart.update({ where: { id: cartId }, data: { status: 'CHECKED_OUT' } });
        return tx.order.findUniqueOrThrow({ where: { id: order.id }, include: ORDER_INCLUDE });
      });
      businessCounter.inc({ event: 'order_placed' });
      return { order, replayed: false };
    } catch (err: any) {
      // Concurrent retry with the same idempotency key lost the unique race: return the winner.
      if (err?.code === 'P2002' && String(err?.meta?.target).includes('idempotency_key')) {
        const winner = await this.prisma.order.findUniqueOrThrow({
          where: { customerId_idempotencyKey: { customerId: actor.id, idempotencyKey: dto.idempotencyKey } },
          include: ORDER_INCLUDE,
        });
        return { order: winner, replayed: true };
      }
      if (err?.code === 'INSUFFICIENT_STOCK') businessCounter.inc({ event: 'reservation_failed' });
      throw err;
    }
  }

  async list(actor: AuthContext, q: OrderListQuery) {
    const where: Prisma.OrderWhereInput = {
      organizationId: actor.organizationId,
      status: q.status as any,
      darkStoreId: q.darkStoreId,
      ...(actor.kind === 'customer' ? { customerId: actor.id } : { customerId: q.customerId, ...warehouseScopeFilter(actor, 'darkStoreId') }),
      orderNumber: q.search ? { contains: q.search, mode: 'insensitive' } : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({ where, include: { items: true, customer: actor.kind === 'customer' ? false : { select: { fullName: true, phone: true } } }, ...pageArgs(q, ['placedAt', 'total', 'status'], 'placedAt') }),
      this.prisma.order.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  async get(actor: AuthContext, id: string) {
    const order = await this.prisma.order.findFirst({ where: { id, organizationId: actor.organizationId }, include: ORDER_INCLUDE });
    if (!order) throw NotFound('Order', id);
    if (actor.kind === 'customer' && order.customerId !== actor.id) throw NotFound('Order', id);
    if (actor.kind === 'employee') assertWarehouseAccess(actor, order.darkStoreId);
    const delivery = await this.prisma.deliveryAssignment.findFirst({
      where: { orderId: id }, orderBy: { assignedAt: 'desc' },
      include: { rider: { select: { fullName: true, phone: actor.kind === 'customer' ? false : true, vehicleType: true } }, events: { orderBy: { createdAt: 'asc' } } },
    });
    // The handover OTP is shown to the customer only; staff and riders must obtain it at the door.
    return { ...order, deliveryOtp: actor.kind === 'customer' ? order.deliveryOtp : null, delivery };
  }

  async history(actor: AuthContext, id: string) {
    const o = await this.get(actor, id);
    return o.statusHistory;
  }

  /** Cancels and releases the reservation exactly once; picked goods go back to stock. */
  async cancel(actor: AuthContext, id: string, reason: string) {
    const order = await this.get(actor, id);
    const allowed = actor.kind === 'customer' ? CUSTOMER_CANCELLABLE : STAFF_CANCELLABLE;
    if (actor.kind === 'employee' && !hasPermission(actor, PERMISSIONS.ORDERS_MANAGE)) throw Forbidden();
    if (!allowed.includes(order.status)) {
      throw Conflict('NOT_CANCELLABLE', `Order in status ${order.status} can no longer be cancelled${actor.kind === 'customer' ? ' online; contact support' : ''}`);
    }
    return this.prisma.withRetry(async (tx) => {
      await this.state.transition(tx, id, 'CANCELLED', actor, 'order.cancelled', reason, allowed);
      if (order.reservationId) await this.reservations.release(tx, actor, order.reservationId, `order cancelled: ${reason}`);
      await this.restockPicked(tx, actor, id, 'order cancelled after pick');
      await tx.pickingTask.updateMany({ where: { orderId: id, status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
      await tx.packingTask.updateMany({ where: { orderId: id, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
      const captured = order.payments.find((p) => p.status === 'CAPTURED');
      if (captured) {
        await tx.payment.update({ where: { id: captured.id }, data: { status: 'REFUND_PENDING' } });
        await tx.refund.create({ data: { paymentId: captured.id, amount: captured.amount, reason: `order cancelled: ${reason}` } });
        await this.state.transition(tx, id, 'REFUND_PENDING', SYSTEM_ACTOR(order.organizationId), 'refund.created');
      }
      await this.audit.record({ actor, action: 'order.cancel', resourceType: 'order', resourceId: id, after: { reason } }, tx);
      return tx.order.findUniqueOrThrow({ where: { id }, include: ORDER_INCLUDE });
    });
  }

  async requestReturn(actor: AuthContext, id: string, reason: string) {
    const order = await this.get(actor, id);
    if (order.status !== 'DELIVERED') throw Conflict('NOT_RETURNABLE', 'Only delivered orders can be returned');
    if (order.deliveredAt && Date.now() - order.deliveredAt.getTime() > RETURN_WINDOW_HOURS * 3_600_000) {
      throw Conflict('RETURN_WINDOW_CLOSED', `Returns are accepted within ${RETURN_WINDOW_HOURS} hours of delivery`);
    }
    await this.prisma.$transaction((tx) => this.state.transition(tx, id, 'RETURN_REQUESTED', actor, 'return.requested', reason));
    return this.get(actor, id);
  }

  /** Inspection of returned goods: resalable units go back to AVAILABLE, the rest to DAMAGED. */
  async receiveReturn(actor: AuthContext, id: string, dto: ReceiveReturnDto) {
    const order = await this.get(actor, id);
    if (order.status !== 'RETURN_REQUESTED') throw Conflict('INVALID_ORDER_TRANSITION', 'Order has no open return request');
    return this.prisma.withRetry(async (tx) => {
      let refundAmount = 0;
      for (const line of dto.lines) {
        const item = order.items.find((i) => i.id === line.orderItemId);
        if (!item) throw NotFound('Order item', line.orderItemId);
        if (line.quantity > item.pickedQty) throw new DomainError('OVER_RETURN', `Cannot return more than delivered for ${item.skuCode}`, 400);
        if (!line.quantity) continue;
        const pick = await tx.pickingItem.findFirst({ where: { orderItemId: item.id, pickedQty: { gt: 0 } } });
        if (!pick) throw new DomainError('NO_PICK_RECORD', `No pick record for ${item.skuCode}`, 409);
        const bal = await tx.inventoryBalance.findUniqueOrThrow({ where: { batchId: pick.batchId } });
        await this.ledger.move(tx, {
          balanceId: bal.id, from: 'NONE', to: line.condition === 'RESALABLE' ? 'AVAILABLE' : 'DAMAGED', quantity: line.quantity, type: 'RETURN_IN',
          referenceType: 'order_return', referenceId: id, actor, reason: `customer return (${line.condition.toLowerCase()})`,
          idempotencyKey: `return:${item.id}`,
        });
        refundAmount += Number(item.unitPrice) * line.quantity;
      }
      await this.state.transition(tx, id, 'RETURNED', actor, 'return.received');
      const payment = order.payments.find((p) => p.status === 'CAPTURED' || p.status === 'COD_COLLECTED');
      if (payment && refundAmount > 0) {
        await tx.refund.create({ data: { paymentId: payment.id, amount: round2(refundAmount), reason: 'customer return' } });
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUND_PENDING' } });
      }
      await this.state.transition(tx, id, 'REFUND_PENDING', actor, 'refund.created');
      await this.audit.record({ actor, action: 'order.return_received', resourceType: 'order', resourceId: id, after: { ...dto, refundAmount } }, tx);
      return tx.order.findUniqueOrThrow({ where: { id }, include: ORDER_INCLUDE });
    });
  }

  /** Cancels unpaid orders whose reservation TTL has elapsed. */
  async cancelStaleUnpaid() {
    const stale = await this.prisma.order.findMany({
      where: { status: { in: ['PAYMENT_PENDING', 'PAYMENT_FAILED'] }, placedAt: { lt: new Date(Date.now() - Number(process.env.RESERVATION_TTL_MINUTES ?? 15) * 60_000) } },
      select: { id: true, organizationId: true, reservationId: true },
      take: 200,
    });
    let cancelled = 0;
    for (const o of stale) {
      try {
        await this.prisma.withRetry(async (tx) => {
          const sys = SYSTEM_ACTOR(o.organizationId);
          await this.state.transition(tx, o.id, 'CANCELLED', sys, 'payment.timeout', 'payment not completed in time', ['PAYMENT_PENDING', 'PAYMENT_FAILED']);
          if (o.reservationId) await this.reservations.release(tx, sys, o.reservationId, 'payment timeout');
        });
        cancelled++;
      } catch (e) {
        this.logger.warn(`could not auto-cancel ${o.id}: ${(e as Error).message}`);
      }
    }
    return { scanned: stale.length, cancelled };
  }

  private async restockPicked(tx: Tx, actor: AuthContext, orderId: string, reason: string) {
    const picked = await tx.pickingItem.findMany({ where: { task: { orderId, status: 'COMPLETED' }, pickedQty: { gt: 0 } } });
    for (const p of picked) {
      const bal = await tx.inventoryBalance.findUniqueOrThrow({ where: { batchId: p.batchId } });
      await this.ledger.move(tx, {
        balanceId: bal.id, from: 'NONE', to: 'AVAILABLE', quantity: p.pickedQty, type: 'RETURN_IN',
        referenceType: 'order_cancel', referenceId: orderId, actor, reason, idempotencyKey: `restock:${p.id}`,
      });
    }
  }

  private async applyPromotion(tx: Tx, organizationId: string, code: string, subtotal: number) {
    const promo = await tx.promotion.findUnique({ where: { organizationId_code: { organizationId, code: code.toUpperCase() } } });
    const now = new Date();
    if (!promo || !promo.active || promo.startsAt > now || promo.endsAt < now) throw new DomainError('INVALID_PROMOTION', 'Coupon is not valid', 422);
    if (subtotal < Number(promo.minOrderValue)) throw new DomainError('PROMOTION_MIN_VALUE', `Coupon needs a minimum order of ${promo.minOrderValue}`, 422);
    const used = await tx.$executeRaw`
      UPDATE promotions SET used_count = used_count + 1
      WHERE id = ${promo.id}::uuid AND (usage_limit IS NULL OR used_count < usage_limit)`;
    if (!used) throw new DomainError('PROMOTION_EXHAUSTED', 'Coupon usage limit reached', 422);
    let discount = promo.discountType === 'PERCENT' ? (subtotal * Number(promo.discountValue)) / 100 : Number(promo.discountValue);
    if (promo.maxDiscount) discount = Math.min(discount, Number(promo.maxDiscount));
    return round2(Math.min(discount, subtotal));
  }
}
