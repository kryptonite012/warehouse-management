import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthContext } from '../../common/auth-context';
import { PrismaService } from '../../common/prisma.service';

export interface Range {
  from: Date;
  to: Date;
  warehouseId?: string;
}

/**
 * All figures are computed from operational tables at request time.
 * Scope: callers restricted to warehouses only see their sites' numbers.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private scope(actor: AuthContext, column: string, warehouseId?: string) {
    const col = Prisma.raw(column);
    if (warehouseId) return Prisma.sql`AND ${col} = ${warehouseId}::uuid`;
    if (actor.isSuperAdmin || actor.warehouseIds === null) return Prisma.empty;
    return Prisma.sql`AND ${col} = ANY(${actor.warehouseIds}::uuid[])`;
  }

  async overview(actor: AuthContext, warehouseId?: string) {
    const org = actor.organizationId;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const ws = this.scope(actor, 'w.id', warehouseId);
    const os = this.scope(actor, 'o.dark_store_id', warehouseId);
    const bs = this.scope(actor, 'b.warehouse_id', warehouseId);

    const [sites] = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*) FILTER (WHERE w.type <> 'DARK_STORE' AND w.status = 'ACTIVE')::int AS "activeWarehouses",
             COUNT(*) FILTER (WHERE w.type = 'DARK_STORE' AND w.status = 'ACTIVE')::int AS "activeDarkStores"
      FROM warehouses w WHERE w.organization_id = ${org}::uuid AND w.deleted_at IS NULL ${ws}`;
    const [catalog] = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS "totalSkus" FROM skus WHERE organization_id = ${org}::uuid AND status = 'ACTIVE'`;
    const [inv] = await this.prisma.$queryRaw<any[]>`
      WITH s AS (
        SELECT b.warehouse_id, b.sku_id, SUM(b.available) AS available, SUM(b.on_hand) AS on_hand, MAX(k.reorder_point) AS rp,
               SUM(b.on_hand * t.unit_cost) AS value
        FROM inventory_balances b JOIN skus k ON k.id = b.sku_id JOIN inventory_batches t ON t.id = b.batch_id
        WHERE b.organization_id = ${org}::uuid ${bs}
        GROUP BY b.warehouse_id, b.sku_id)
      SELECT COALESCE(SUM(value), 0)::float AS "inventoryValuation",
             COUNT(*) FILTER (WHERE available > 0 AND available <= rp)::int AS "lowStockSkus",
             COUNT(*) FILTER (WHERE available = 0)::int AS "outOfStockSkus",
             COUNT(*)::int AS "stockedSkuLocations",
             CASE WHEN COUNT(*) > 0 THEN COUNT(*) FILTER (WHERE available = 0)::float / COUNT(*) END AS "stockoutRate"
      FROM s`;
    const [expiring] = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS batches, COALESCE(SUM(b.on_hand), 0)::int AS units
      FROM inventory_batches t JOIN inventory_balances b ON b.batch_id = t.id
      WHERE t.organization_id = ${org}::uuid AND t.status = 'ACTIVE' AND t.expires_at <= CURRENT_DATE + 3 AND b.on_hand > 0 ${bs}`;
    const statuses = await this.prisma.$queryRaw<{ status: string; count: number }[]>`
      SELECT o.status, COUNT(*)::int AS count FROM orders o
      WHERE o.organization_id = ${org}::uuid AND o.placed_at >= ${today} ${os} GROUP BY o.status`;
    const by = Object.fromEntries(statuses.map((s) => [s.status, s.count]));
    const sum = (...k: string[]) => k.reduce((a, s) => a + (by[s] ?? 0), 0);
    const [timing] = await this.prisma.$queryRaw<any[]>`
      SELECT AVG(EXTRACT(EPOCH FROM (o.delivered_at - o.placed_at)) / 60)::float AS "avgFulfillmentMinutes",
             COUNT(*)::int AS delivered
      FROM orders o WHERE o.organization_id = ${org}::uuid AND o.delivered_at >= ${today} ${os}`;
    const [pick] = await this.prisma.$queryRaw<any[]>`
      SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at)))::float AS "avgPickSeconds",
             SUM((SELECT COALESCE(SUM(picked_qty),0) FROM picking_items i WHERE i.picking_task_id = t.id))::int AS units
      FROM picking_tasks t WHERE t.organization_id = ${org}::uuid AND t.completed_at >= ${today} ${this.scope(actor, 't.warehouse_id', warehouseId)}`;
    const [util] = await this.prisma.$queryRaw<any[]>`
      WITH slotted AS (
        SELECT DISTINCT ON (sl.sku_id, sl.warehouse_id) sl.sku_id, sl.warehouse_id FROM sku_locations sl
        JOIN storage_locations l ON l.id = sl.location_id
        WHERE l.organization_id = ${org}::uuid ${this.scope(actor, 'l.warehouse_id', warehouseId)}),
      used AS (
        SELECT COALESCE(SUM(b.on_hand + b.quarantined + b.damaged), 0) AS units FROM inventory_balances b
        JOIN slotted s ON s.sku_id = b.sku_id AND s.warehouse_id = b.warehouse_id),
      cap AS (
        SELECT SUM(capacity_units) AS units FROM storage_locations l
        WHERE l.organization_id = ${org}::uuid AND l.level = 'BIN' ${this.scope(actor, 'l.warehouse_id', warehouseId)})
      SELECT CASE WHEN cap.units > 0 THEN used.units::float / cap.units END AS utilization FROM used, cap`;
    const [del] = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*) FILTER (WHERE a.status = 'DELIVERED')::int AS delivered, COUNT(*) FILTER (WHERE a.status = 'FAILED')::int AS failed
      FROM delivery_assignments a WHERE a.organization_id = ${org}::uuid AND a.assigned_at >= ${today} ${this.scope(actor, 'a.dark_store_id', warehouseId)}`;

    return {
      generatedAt: new Date().toISOString(),
      dataSource: 'live',
      sites,
      catalog,
      inventory: { ...inv, expiringWithin3Days: expiring },
      ordersToday: {
        total: statuses.reduce((a, s) => a + s.count, 0),
        pending: sum('CREATED', 'PAYMENT_PENDING', 'PAYMENT_CONFIRMED', 'INVENTORY_RESERVED', 'ACCEPTED'),
        picking: sum('PICKING'),
        packing: sum('PICKED', 'PARTIALLY_FULFILLED', 'PACKING', 'PACKED'),
        dispatched: sum('READY_FOR_DISPATCH', 'RIDER_ASSIGNED', 'OUT_FOR_DELIVERY'),
        delivered: sum('DELIVERED', 'RETURN_REQUESTED', 'RETURNED'),
        cancelled: sum('CANCELLED', 'REFUND_PENDING', 'REFUNDED'),
        byStatus: by,
      },
      performance: {
        avgFulfillmentMinutes: timing.avgFulfillmentMinutes,
        avgPickSeconds: pick.avgPickSeconds,
        unitsPickedToday: pick.units ?? 0,
        warehouseUtilization: util.utilization,
        deliverySuccessRate: del.delivered + del.failed > 0 ? del.delivered / (del.delivered + del.failed) : null,
      },
    };
  }

  async sales(actor: AuthContext, r: Range, granularity: 'hour' | 'day') {
    const unit = Prisma.raw(granularity === 'hour' ? `'hour'` : `'day'`);
    const os = this.scope(actor, 'o.dark_store_id', r.warehouseId);
    const series = await this.prisma.$queryRaw<any[]>`
      SELECT date_trunc(${unit}, o.placed_at) AS bucket, COUNT(*)::int AS orders,
             COALESCE(SUM(o.total) FILTER (WHERE o.status NOT IN ('CANCELLED','PAYMENT_FAILED','REFUNDED')), 0)::float AS revenue,
             COUNT(*) FILTER (WHERE o.status = 'CANCELLED')::int AS cancelled
      FROM orders o WHERE o.organization_id = ${actor.organizationId}::uuid AND o.placed_at >= ${r.from} AND o.placed_at < ${r.to} ${os}
      GROUP BY 1 ORDER BY 1`;
    const byCategory = await this.prisma.$queryRaw<any[]>`
      SELECT c.name AS category, SUM(i.quantity)::int AS units, SUM(i.line_total)::float AS revenue
      FROM order_items i JOIN orders o ON o.id = i.order_id JOIN skus k ON k.id = i.sku_id
      JOIN products p ON p.id = k.product_id JOIN product_categories c ON c.id = p.category_id
      WHERE o.organization_id = ${actor.organizationId}::uuid AND o.placed_at >= ${r.from} AND o.placed_at < ${r.to}
        AND o.status NOT IN ('CANCELLED','PAYMENT_FAILED','REFUNDED') ${os}
      GROUP BY c.name ORDER BY revenue DESC`;
    const byStore = await this.prisma.$queryRaw<any[]>`
      SELECT w.code, w.name, COUNT(*)::int AS orders, SUM(o.total)::float AS revenue
      FROM orders o JOIN warehouses w ON w.id = o.dark_store_id
      WHERE o.organization_id = ${actor.organizationId}::uuid AND o.placed_at >= ${r.from} AND o.placed_at < ${r.to}
        AND o.status NOT IN ('CANCELLED','PAYMENT_FAILED','REFUNDED') ${os}
      GROUP BY w.code, w.name ORDER BY revenue DESC`;
    const topProducts = await this.prisma.$queryRaw<any[]>`
      SELECT i.sku_code AS "skuCode", i.product_name AS name, SUM(i.quantity)::int AS units, SUM(i.line_total)::float AS revenue
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.organization_id = ${actor.organizationId}::uuid AND o.placed_at >= ${r.from} AND o.placed_at < ${r.to}
        AND o.status NOT IN ('CANCELLED','PAYMENT_FAILED','REFUNDED') ${os}
      GROUP BY 1, 2 ORDER BY units DESC LIMIT 20`;
    return { range: r, granularity, series, byCategory, byStore, topProducts };
  }

  async inventory(actor: AuthContext, warehouseId?: string) {
    const bs = this.scope(actor, 'b.warehouse_id', warehouseId);
    const distribution = await this.prisma.$queryRaw<any[]>`
      SELECT w.code, w.name, w.type, SUM(b.on_hand)::int AS "onHand", SUM(b.reserved)::int AS reserved,
             SUM(b.damaged)::int AS damaged, SUM(b.quarantined)::int AS quarantined, SUM(b.expired)::int AS expired,
             SUM(b.in_transit)::int AS "inTransit", SUM(b.on_hand * t.unit_cost)::float AS value
      FROM inventory_balances b JOIN warehouses w ON w.id = b.warehouse_id JOIN inventory_batches t ON t.id = b.batch_id
      WHERE b.organization_id = ${actor.organizationId}::uuid ${bs}
      GROUP BY w.code, w.name, w.type ORDER BY w.code`;
    const expiry = await this.prisma.$queryRaw<any[]>`
      SELECT CASE WHEN t.expires_at < CURRENT_DATE THEN 'expired'
                  WHEN t.expires_at <= CURRENT_DATE + 3 THEN '0-3 days'
                  WHEN t.expires_at <= CURRENT_DATE + 7 THEN '4-7 days'
                  WHEN t.expires_at <= CURRENT_DATE + 30 THEN '8-30 days'
                  WHEN t.expires_at IS NULL THEN 'no expiry' ELSE '30+ days' END AS bucket,
             SUM(b.on_hand + b.expired + b.quarantined)::int AS units,
             MIN(COALESCE(t.expires_at, DATE '9999-12-31')) AS sort_key
      FROM inventory_batches t JOIN inventory_balances b ON b.batch_id = t.id
      WHERE t.organization_id = ${actor.organizationId}::uuid ${bs}
      GROUP BY 1 ORDER BY sort_key`;
    const movements = await this.prisma.$queryRaw<any[]>`
      SELECT movement_type AS type, COUNT(*)::int AS count, SUM(quantity)::int AS units
      FROM inventory_movements b WHERE b.organization_id = ${actor.organizationId}::uuid AND b.created_at >= now() - interval '7 days' ${bs}
      GROUP BY 1 ORDER BY 2 DESC`;
    const slowMoving = await this.prisma.$queryRaw<any[]>`
      SELECT k.code, p.name, SUM(b.on_hand)::int AS "onHand",
             (SELECT MAX(m.created_at) FROM inventory_movements m WHERE m.sku_id = k.id AND m.movement_type = 'PICK') AS "lastSoldAt"
      FROM inventory_balances b JOIN skus k ON k.id = b.sku_id JOIN products p ON p.id = k.product_id
      WHERE b.organization_id = ${actor.organizationId}::uuid AND b.on_hand > 0 ${bs}
      GROUP BY k.id, k.code, p.name
      HAVING NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.sku_id = k.id AND m.movement_type = 'PICK' AND m.created_at >= now() - interval '14 days')
      ORDER BY "onHand" DESC LIMIT 50`;
    return { distribution, expiry, movementsLast7Days: movements, slowMoving };
  }

  async warehouse(actor: AuthContext, r: Range) {
    return this.prisma.$queryRaw<any[]>`
      SELECT w.id, w.code, w.name, w.type,
        (SELECT COUNT(*) FROM orders o WHERE o.dark_store_id = w.id AND o.placed_at >= ${r.from} AND o.placed_at < ${r.to})::int AS orders,
        (SELECT AVG(EXTRACT(EPOCH FROM (o.delivered_at - o.placed_at)) / 60) FROM orders o WHERE o.dark_store_id = w.id AND o.delivered_at >= ${r.from} AND o.delivered_at < ${r.to})::float AS "avgFulfillmentMinutes",
        (SELECT AVG(EXTRACT(EPOCH FROM (t.completed_at - t.started_at))) FROM picking_tasks t WHERE t.warehouse_id = w.id AND t.completed_at >= ${r.from} AND t.completed_at < ${r.to})::float AS "avgPickSeconds",
        ((SELECT SUM(b.on_hand + b.quarantined + b.damaged) FROM inventory_balances b
           WHERE b.warehouse_id = w.id AND EXISTS (SELECT 1 FROM sku_locations sl WHERE sl.sku_id = b.sku_id AND sl.warehouse_id = w.id))::float
         / NULLIF((SELECT SUM(capacity_units) FROM storage_locations l WHERE l.warehouse_id = w.id AND l.level = 'BIN'), 0)) AS utilization,
        (SELECT COUNT(*) FROM goods_receipts g WHERE g.warehouse_id = w.id AND g.created_at >= ${r.from} AND g.created_at < ${r.to})::int AS receipts
      FROM warehouses w WHERE w.organization_id = ${actor.organizationId}::uuid AND w.deleted_at IS NULL ${this.scope(actor, 'w.id', r.warehouseId)}
      ORDER BY w.code`;
  }

  async procurement(actor: AuthContext, r: Range) {
    const byStatus = await this.prisma.$queryRaw<any[]>`
      SELECT status, COUNT(*)::int AS count, SUM(total)::float AS value FROM purchase_orders
      WHERE organization_id = ${actor.organizationId}::uuid AND created_at >= ${r.from} AND created_at < ${r.to} GROUP BY status`;
    const suppliers = await this.prisma.$queryRaw<any[]>`
      SELECT s.code, s.name, COUNT(DISTINCT po.id)::int AS orders, SUM(i.ordered_qty)::int AS ordered,
             SUM(i.accepted_qty)::int AS accepted, SUM(i.rejected_qty)::int AS rejected,
             CASE WHEN SUM(i.ordered_qty) > 0 THEN SUM(i.accepted_qty)::float / SUM(i.ordered_qty) END AS "fillRate"
      FROM suppliers s JOIN purchase_orders po ON po.supplier_id = s.id JOIN purchase_order_items i ON i.purchase_order_id = po.id
      WHERE s.organization_id = ${actor.organizationId}::uuid AND po.created_at >= ${r.from} AND po.created_at < ${r.to}
        AND po.status NOT IN ('DRAFT', 'CANCELLED')
      GROUP BY s.code, s.name ORDER BY orders DESC`;
    return { byStatus, suppliers };
  }

  async fulfillment(actor: AuthContext, r: Range) {
    const os = this.scope(actor, 'o.dark_store_id', r.warehouseId);
    // Average time spent in each stage, from the immutable status history.
    const stages = await this.prisma.$queryRaw<any[]>`
      WITH h AS (
        SELECT h.order_id, h.to_status, h.created_at,
               LEAD(h.created_at) OVER (PARTITION BY h.order_id ORDER BY h.created_at) AS next_at
        FROM order_status_history h JOIN orders o ON o.id = h.order_id
        WHERE o.organization_id = ${actor.organizationId}::uuid AND o.placed_at >= ${r.from} AND o.placed_at < ${r.to} ${os})
      SELECT to_status AS stage, COUNT(*)::int AS orders, AVG(EXTRACT(EPOCH FROM (next_at - created_at)))::float AS "avgSeconds",
             PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (next_at - created_at)))::float AS "p90Seconds"
      FROM h WHERE next_at IS NOT NULL GROUP BY to_status ORDER BY "avgSeconds" DESC`;
    const [shorts] = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*) FILTER (WHERE o.status = 'PARTIALLY_FULFILLED' OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.picked_qty < i.quantity AND o.status NOT IN ('CREATED','PAYMENT_PENDING','ACCEPTED','PICKING','CANCELLED')))::int AS "shortPickedOrders",
             COUNT(*)::int AS orders
      FROM orders o WHERE o.organization_id = ${actor.organizationId}::uuid AND o.placed_at >= ${r.from} AND o.placed_at < ${r.to} ${os}`;
    return { stages, bottleneck: stages[0]?.stage ?? null, ...shorts };
  }
}
