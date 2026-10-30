import { OrderStatus } from '@prisma/client';

/**
 * Order state machine. Any transition not listed here is rejected.
 * Inventory is reserved at checkout (inside the CREATED transaction) so stock cannot
 * be oversold while a payment is in flight; INVENTORY_RESERVED marks that the order
 * is paid (or COD) and holds a confirmed reservation.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ['PAYMENT_PENDING', 'INVENTORY_RESERVED', 'CANCELLED'],
  PAYMENT_PENDING: ['PAYMENT_CONFIRMED', 'PAYMENT_FAILED', 'CANCELLED'],
  PAYMENT_CONFIRMED: ['INVENTORY_RESERVED', 'CANCELLED'],
  PAYMENT_FAILED: ['PAYMENT_PENDING', 'CANCELLED'],
  INVENTORY_RESERVED: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PICKING', 'CANCELLED'],
  PICKING: ['PICKED', 'PARTIALLY_FULFILLED', 'CANCELLED'],
  PICKED: ['PACKING', 'CANCELLED'],
  PARTIALLY_FULFILLED: ['PACKING', 'CANCELLED'],
  PACKING: ['PACKED'],
  PACKED: ['READY_FOR_DISPATCH'],
  READY_FOR_DISPATCH: ['RIDER_ASSIGNED'],
  RIDER_ASSIGNED: ['OUT_FOR_DELIVERY', 'READY_FOR_DISPATCH'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'READY_FOR_DISPATCH', 'RETURNED'],
  DELIVERED: ['RETURN_REQUESTED'],
  RETURN_REQUESTED: ['RETURNED', 'DELIVERED'],
  RETURNED: ['REFUND_PENDING'],
  CANCELLED: ['REFUND_PENDING'],
  REFUND_PENDING: ['REFUNDED'],
  REFUNDED: [],
};

/** Customers may self-cancel only before the store starts picking. */
export const CUSTOMER_CANCELLABLE: OrderStatus[] = ['CREATED', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAYMENT_CONFIRMED', 'INVENTORY_RESERVED', 'ACCEPTED'];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export const ACTIVE_STATUSES: OrderStatus[] = [
  'CREATED', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'INVENTORY_RESERVED', 'ACCEPTED', 'PICKING', 'PICKED',
  'PARTIALLY_FULFILLED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH', 'RIDER_ASSIGNED', 'OUT_FOR_DELIVERY',
];
