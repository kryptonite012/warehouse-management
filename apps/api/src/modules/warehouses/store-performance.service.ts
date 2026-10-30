import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

/** Store KPIs computed from orders, picking tasks and inventory. No synthetic values. */
@Injectable()
export class StorePerformanceService {
  constructor(private readonly prisma: PrismaService) {}

  async forStore(storeId: string, days: number) {
    const since = new Date(Date.now() - days * 86_400_000);
    const [statusCounts, timing, picking, stock, store] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], where: { darkStoreId: storeId, placedAt: { gte: since } }, _count: true }),
      this.prisma.$queryRaw<{ avg_minutes: number | null; p90_minutes: number | null; delivered: bigint }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM (delivered_at - placed_at)) / 60)::float AS avg_minutes,
               PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (delivered_at - placed_at)) / 60)::float AS p90_minutes,
               COUNT(*) AS delivered
        FROM orders WHERE dark_store_id = ${storeId}::uuid AND delivered_at IS NOT NULL AND placed_at >= ${since}`,
      this.prisma.$queryRaw<{ avg_pick_seconds: number | null; tasks: bigint }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at)))::float AS avg_pick_seconds, COUNT(*) AS tasks
        FROM picking_tasks WHERE warehouse_id = ${storeId}::uuid AND completed_at IS NOT NULL AND created_at >= ${since}`,
      this.prisma.$queryRaw<{ skus: bigint; out_of_stock: bigint; low_stock: bigint }[]>`
        WITH s AS (
          SELECT b.sku_id, SUM(b.available) AS available, MAX(k.reorder_point) AS rp
          FROM inventory_balances b JOIN skus k ON k.id = b.sku_id
          WHERE b.warehouse_id = ${storeId}::uuid GROUP BY b.sku_id)
        SELECT COUNT(*) AS skus,
               COUNT(*) FILTER (WHERE available = 0) AS out_of_stock,
               COUNT(*) FILTER (WHERE available > 0 AND available <= rp) AS low_stock FROM s`,
      this.prisma.darkStore.findUnique({ where: { id: storeId } }),
    ]);
    const counts = Object.fromEntries(statusCounts.map((s) => [s.status, s._count]));
    const total = statusCounts.reduce((s, r) => s + r._count, 0);
    const st = stock[0];
    return {
      period: { days, from: since.toISOString(), to: new Date().toISOString() },
      orders: { total, byStatus: counts, cancelled: counts.CANCELLED ?? 0 },
      fulfillment: {
        deliveredCount: Number(timing[0]?.delivered ?? 0),
        avgOrderToDeliveryMinutes: timing[0]?.avg_minutes ?? null,
        p90OrderToDeliveryMinutes: timing[0]?.p90_minutes ?? null,
        avgPickSeconds: picking[0]?.avg_pick_seconds ?? null,
        pickTasksCompleted: Number(picking[0]?.tasks ?? 0),
      },
      inventory: {
        skusStocked: Number(st?.skus ?? 0),
        outOfStock: Number(st?.out_of_stock ?? 0),
        lowStock: Number(st?.low_stock ?? 0),
        stockoutRate: st && Number(st.skus) ? Number(st.out_of_stock) / Number(st.skus) : null,
      },
      sync: { lastSyncAt: store?.lastSyncAt ?? null, acceptingOrders: store?.acceptingOrders ?? null },
    };
  }
}
