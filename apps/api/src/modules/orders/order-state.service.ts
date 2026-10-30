import { Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { AuthContext } from '../../common/auth-context';
import { Conflict, NotFound } from '../../common/errors';
import { OutboxService } from '../../common/outbox.service';
import { Tx } from '../../common/prisma.service';
import { canTransition } from './order-state';

@Injectable()
export class OrderStateService {
  constructor(private readonly outbox: OutboxService) {}

  /**
   * Compare-and-set transition. Validates against the state machine, then updates
   * only if the row is still in the expected status; records history in the same tx.
   */
  async transition(tx: Tx, orderId: string, to: OrderStatus, actor: AuthContext, event: string, reason?: string, expectedFrom?: OrderStatus[]) {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw NotFound('Order', orderId);
    if (expectedFrom && !expectedFrom.includes(order.status)) {
      throw Conflict('INVALID_ORDER_TRANSITION', `Order is ${order.status}; expected ${expectedFrom.join(' / ')}`);
    }
    if (!canTransition(order.status, to)) {
      throw Conflict('INVALID_ORDER_TRANSITION', `Cannot move order from ${order.status} to ${to}`, { from: order.status, to });
    }
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: order.status, version: order.version },
      data: {
        status: to,
        version: { increment: 1 },
        deliveredAt: to === 'DELIVERED' ? new Date() : undefined,
        cancelReason: to === 'CANCELLED' ? reason : undefined,
      },
    });
    if (!count) throw Conflict('CONCURRENT_UPDATE', 'Order changed concurrently; retry');
    await tx.orderStatusHistory.create({
      data: {
        orderId, fromStatus: order.status, toStatus: to, actorType: actor.kind.toUpperCase(),
        actorId: actor.kind === 'system' ? null : actor.id, reason, event,
      },
    });
    await this.outbox.emit(tx, `order.${to.toLowerCase()}`, orderId, {
      orderId, orderNumber: order.orderNumber, darkStoreId: order.darkStoreId, customerId: order.customerId, from: order.status, to, event, reason,
    });
    return { from: order.status, to };
  }
}
