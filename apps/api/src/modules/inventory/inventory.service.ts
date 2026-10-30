import { Injectable, Logger } from '@nestjs/common';
import { InventoryBucket, MovementType, Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { assertWarehouseAccess, AuthContext, hasPermission, SYSTEM_ACTOR, warehouseScopeFilter } from '../../common/auth-context';
import { Conflict, DomainError, Forbidden, NotFound } from '../../common/errors';
import { nextDocNumber } from '../../common/doc-number';
import { pageArgs, toPage } from '../../common/pagination';
import { PERMISSIONS } from '../../common/permissions';
import { PrismaService, Tx } from '../../common/prisma.service';
import {
  CreateAdjustmentDto, CreateCountDto, CreateReservationDto, CreateTransferDto, DecisionDto, InventoryQuery, MovementQuery,
  ReceiveTransferDto, StatusChangeDto, SubmitCountDto,
} from './inventory.dto';
import { LedgerService } from './ledger.service';
import { ReservationService } from './reservation.service';

const STATUS_ACTIONS: Record<string, { from: InventoryBucket; to: InventoryBucket; type: MovementType }> = {
  DAMAGE: { from: 'AVAILABLE', to: 'DAMAGED', type: 'DAMAGE' },
  QUARANTINE: { from: 'AVAILABLE', to: 'QUARANTINED', type: 'QUARANTINE' },
  QUARANTINE_RELEASE: { from: 'QUARANTINED', to: 'AVAILABLE', type: 'QUARANTINE_RELEASE' },
  QUARANTINE_TO_DAMAGED: { from: 'QUARANTINED', to: 'DAMAGED', type: 'DAMAGE' },
};

@Injectable()
export class InventoryService {
  private readonly logger = new Logger('Inventory');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly reservations: ReservationService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ queries

  /** Stock summary per (warehouse, SKU) with every bucket reported separately. */
  async summary(actor: AuthContext, q: InventoryQuery) {
    if (q.warehouseId) assertWarehouseAccess(actor, q.warehouseId);
    const scope = actor.isSuperAdmin || actor.warehouseIds === null ? null : actor.warehouseIds;
    const search = q.search ? `%${q.search}%` : null;
    const having =
      q.stock === 'OUT' ? Prisma.sql`HAVING SUM(b.available) = 0`
      : q.stock === 'LOW' ? Prisma.sql`HAVING SUM(b.available) > 0 AND SUM(b.available) <= MAX(k.reorder_point)`
      : q.stock === 'IN' ? Prisma.sql`HAVING SUM(b.available) > 0`
      : Prisma.empty;
    const where = Prisma.sql`
      WHERE b.organization_id = ${actor.organizationId}::uuid
      ${q.warehouseId ? Prisma.sql`AND b.warehouse_id = ${q.warehouseId}::uuid` : Prisma.empty}
      ${q.skuId ? Prisma.sql`AND b.sku_id = ${q.skuId}::uuid` : Prisma.empty}
      ${scope ? Prisma.sql`AND b.warehouse_id = ANY(${scope}::uuid[])` : Prisma.empty}
      ${search ? Prisma.sql`AND (p.name ILIKE ${search} OR k.code ILIKE ${search})` : Prisma.empty}`;
    const base = Prisma.sql`
      FROM inventory_balances b
      JOIN skus k ON k.id = b.sku_id
      JOIN products p ON p.id = k.product_id
      JOIN warehouses w ON w.id = b.warehouse_id
      ${where}
      GROUP BY b.warehouse_id, w.code, w.name, b.sku_id, k.code, p.name, k.reorder_point, k.purchase_price
      ${having}`;
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT b.warehouse_id AS "warehouseId", w.code AS "warehouseCode", w.name AS "warehouseName",
             b.sku_id AS "skuId", k.code AS "skuCode", p.name AS "productName", k.reorder_point AS "reorderPoint",
             SUM(b.on_hand)::int AS "onHand", SUM(b.available)::int AS available, SUM(b.reserved)::int AS reserved,
             SUM(b.damaged)::int AS damaged, SUM(b.quarantined)::int AS quarantined, SUM(b.expired)::int AS expired,
             SUM(b.in_transit)::int AS "inTransit", COUNT(*)::int AS batches,
             (SUM(b.on_hand) * k.purchase_price)::float AS "valuationAtCost"
      ${base}
      ORDER BY p.name, w.code
      LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
    const [{ total }] = await this.prisma.$queryRaw<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM (SELECT 1 ${base}) x`;
    const canSeeCost = hasPermission(actor, PERMISSIONS.REPORTS_READ);
    return toPage(canSeeCost ? rows : rows.map((r) => ({ ...r, valuationAtCost: null })), total, q);
  }

  /** Batch-level detail for one SKU (FEFO order). */
  async skuDetail(actor: AuthContext, skuId: string, warehouseId?: string) {
    if (warehouseId) assertWarehouseAccess(actor, warehouseId);
    const sku = await this.prisma.sku.findFirst({ where: { id: skuId, organizationId: actor.organizationId }, include: { product: true, barcodes: true } });
    if (!sku) throw NotFound('SKU', skuId);
    const batches = await this.prisma.inventoryBatch.findMany({
      where: { skuId, warehouseId, ...warehouseScopeFilter(actor) },
      include: { balance: true, warehouse: { select: { code: true, name: true } } },
      orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { receivedAt: 'asc' }],
    });
    const locations = await this.prisma.skuLocation.findMany({ where: { skuId, warehouseId }, include: { location: true } });
    return { sku, batches, locations: locations.map((l) => ({ warehouseId: l.warehouseId, code: l.location.fullCode, barcode: l.location.barcode, isPrimary: l.isPrimary })) };
  }

  async movements(actor: AuthContext, q: MovementQuery) {
    if (q.warehouseId) assertWarehouseAccess(actor, q.warehouseId);
    const where: Prisma.InventoryMovementWhereInput = {
      organizationId: actor.organizationId,
      warehouseId: q.warehouseId,
      skuId: q.skuId,
      movementType: q.movementType as any,
      referenceId: q.referenceId,
      ...warehouseScopeFilter(actor),
    };
    const [rows, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({ where, ...pageArgs(q, ['createdAt', 'quantity'], 'createdAt') }),
      this.prisma.inventoryMovement.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  /** SKUs at or below reorder point, aggregated per site. */
  async lowStock(actor: AuthContext, warehouseId?: string) {
    if (warehouseId) assertWarehouseAccess(actor, warehouseId);
    return this.summary(actor, Object.assign(new InventoryQuery(), { warehouseId, stock: 'LOW', pageSize: 200 }));
  }

  /** Batches expiring within `days` that still hold stock. */
  async expiring(actor: AuthContext, days: number, warehouseId?: string) {
    if (warehouseId) assertWarehouseAccess(actor, warehouseId);
    const until = new Date(Date.now() + days * 86_400_000);
    return this.prisma.inventoryBatch.findMany({
      where: {
        organizationId: actor.organizationId,
        warehouseId,
        ...warehouseScopeFilter(actor),
        status: 'ACTIVE',
        expiresAt: { lte: until },
        balance: { OR: [{ onHand: { gt: 0 } }, { quarantined: { gt: 0 } }] },
      },
      include: { balance: true, sku: { include: { product: { select: { name: true } } } }, warehouse: { select: { code: true, name: true } } },
      orderBy: { expiresAt: 'asc' },
      take: 500,
    });
  }

  // ------------------------------------------------------------ reservations

  async createReservation(actor: AuthContext, dto: CreateReservationDto) {
    assertWarehouseAccess(actor, dto.warehouseId);
    return this.prisma.withRetry((tx) =>
      this.reservations.reserve(tx, actor, { ...dto, organizationId: actor.organizationId }),
    );
  }

  async releaseReservation(actor: AuthContext, id: string, reason: string) {
    const r = await this.prisma.inventoryReservation.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!r) throw NotFound('Reservation', id);
    assertWarehouseAccess(actor, r.warehouseId);
    const released = await this.prisma.withRetry((tx) => this.reservations.release(tx, actor, id, reason));
    return { released, status: released ? 'RELEASED' : r.status };
  }

  // ------------------------------------------------------------- adjustments

  async requestAdjustment(actor: AuthContext, dto: CreateAdjustmentDto) {
    assertWarehouseAccess(actor, dto.warehouseId);
    const batch = await this.prisma.inventoryBatch.findFirst({ where: { id: dto.batchId, warehouseId: dto.warehouseId, organizationId: actor.organizationId } });
    if (!batch) throw NotFound('Batch', dto.batchId);
    const adj = await this.prisma.inventoryAdjustment.create({
      data: {
        organizationId: actor.organizationId, warehouseId: dto.warehouseId, skuId: batch.skuId, batchId: batch.id,
        bucket: dto.bucket, quantityDelta: dto.quantityDelta, reasonCode: dto.reasonCode, notes: dto.notes, requestedById: actor.id,
      },
    });
    await this.audit.record({ actor, action: 'inventory.adjustment.request', resourceType: 'inventory_adjustment', resourceId: adj.id, after: dto });
    return adj;
  }

  /**
   * Approval applies the ledger movement. Requester cannot approve their own adjustment
   * (segregation of duties); write-offs additionally need inventory.write_off.
   */
  async decideAdjustment(actor: AuthContext, id: string, dto: DecisionDto) {
    const adj = await this.prisma.inventoryAdjustment.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!adj) throw NotFound('Adjustment', id);
    assertWarehouseAccess(actor, adj.warehouseId);
    if (adj.status !== 'PENDING') throw Conflict('ALREADY_DECIDED', `Adjustment is already ${adj.status}`);
    if (adj.requestedById === actor.id && !actor.isSuperAdmin) throw Forbidden('You cannot approve your own adjustment');
    const isWriteOff = adj.quantityDelta < 0 && /WRITE_OFF|LOST|THEFT/.test(adj.reasonCode);
    if (dto.approve && isWriteOff && !hasPermission(actor, PERMISSIONS.INVENTORY_WRITE_OFF)) {
      await this.audit.record({ actor, action: 'inventory.adjustment.approve', resourceType: 'inventory_adjustment', resourceId: id, outcome: 'DENIED', after: { reason: 'write_off permission missing' } });
      throw Forbidden('Approving a write-off requires inventory.write_off');
    }

    return this.prisma.withRetry(async (tx) => {
      const claimed = await tx.inventoryAdjustment.updateMany({
        where: { id, status: 'PENDING' },
        data: { status: dto.approve ? 'APPROVED' : 'REJECTED', approvedById: actor.id, decidedAt: new Date() },
      });
      if (!claimed.count) throw Conflict('ALREADY_DECIDED', 'Adjustment was decided concurrently');
      if (dto.approve) {
        const bal = await tx.inventoryBalance.findUniqueOrThrow({ where: { batchId: adj.batchId } });
        const qty = Math.abs(adj.quantityDelta);
        await this.ledger.move(tx, {
          balanceId: bal.id,
          from: adj.quantityDelta > 0 ? 'NONE' : adj.bucket,
          to: adj.quantityDelta > 0 ? adj.bucket : 'NONE',
          quantity: qty,
          type: adj.quantityDelta > 0 ? 'ADJUSTMENT_IN' : isWriteOff ? 'WRITE_OFF' : 'ADJUSTMENT_OUT',
          referenceType: 'inventory_adjustment', referenceId: adj.id, actor, reason: `${adj.reasonCode}${adj.notes ? `: ${adj.notes}` : ''}`,
          idempotencyKey: `adjustment:${adj.id}`,
        });
      }
      await this.audit.record({ actor, action: dto.approve ? 'inventory.adjustment.approve' : 'inventory.adjustment.reject', resourceType: 'inventory_adjustment', resourceId: id, before: adj, after: dto }, tx);
      return tx.inventoryAdjustment.findUniqueOrThrow({ where: { id } });
    });
  }

  listAdjustments(actor: AuthContext, status?: string, warehouseId?: string) {
    if (warehouseId) assertWarehouseAccess(actor, warehouseId);
    return this.prisma.inventoryAdjustment.findMany({
      where: { organizationId: actor.organizationId, status: status as any, warehouseId, ...warehouseScopeFilter(actor) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** Damage / quarantine transitions between buckets (QC staff). */
  async changeStatus(actor: AuthContext, warehouseId: string, dto: StatusChangeDto) {
    assertWarehouseAccess(actor, warehouseId);
    const spec = STATUS_ACTIONS[dto.action];
    const bal = await this.prisma.inventoryBalance.findFirst({ where: { batchId: dto.batchId, warehouseId, organizationId: actor.organizationId } });
    if (!bal) throw NotFound('Batch at this warehouse', dto.batchId);
    return this.prisma.withRetry(async (tx) => {
      const res = await this.ledger.move(tx, {
        balanceId: bal.id, from: spec.from, to: spec.to, quantity: dto.quantity, type: spec.type,
        referenceType: 'status_change', referenceId: dto.idempotencyKey, actor, reason: dto.reason, idempotencyKey: `status:${dto.idempotencyKey}`,
      });
      await this.audit.record({ actor, action: `inventory.${dto.action.toLowerCase()}`, resourceType: 'inventory_balance', resourceId: bal.id, after: dto }, tx);
      return { ...res, balance: await tx.inventoryBalance.findUniqueOrThrow({ where: { id: bal.id } }) };
    });
  }

  // ----------------------------------------------------------- cycle counts

  async createCount(actor: AuthContext, dto: CreateCountDto) {
    assertWarehouseAccess(actor, dto.warehouseId);
    const balances = await this.prisma.inventoryBalance.findMany({
      where: { warehouseId: dto.warehouseId, skuId: dto.skuIds ? { in: dto.skuIds } : undefined, OR: [{ onHand: { gt: 0 } }, { batch: { status: 'ACTIVE' } }] },
    });
    if (!balances.length) throw new DomainError('NOTHING_TO_COUNT', 'No stock records match this count', 400);
    const count = await this.prisma.inventoryCount.create({
      data: {
        organizationId: actor.organizationId, warehouseId: dto.warehouseId, blind: dto.blind ?? true, createdById: actor.id,
        items: { create: balances.map((b) => ({ skuId: b.skuId, batchId: b.batchId, systemQuantity: b.onHand })) },
      },
      include: { items: true },
    });
    await this.audit.record({ actor, action: 'inventory.count.create', resourceType: 'inventory_count', resourceId: count.id, after: { items: count.items.length } });
    return this.shapeCount(count);
  }

  async getCount(actor: AuthContext, id: string) {
    const c = await this.prisma.inventoryCount.findFirst({ where: { id, organizationId: actor.organizationId }, include: { items: true } });
    if (!c) throw NotFound('Count', id);
    assertWarehouseAccess(actor, c.warehouseId);
    return this.shapeCount(c, hasPermission(actor, PERMISSIONS.INVENTORY_COUNT_RECONCILE));
  }

  async submitCount(actor: AuthContext, id: string, dto: SubmitCountDto) {
    const c = await this.getCount(actor, id);
    if (c.status !== 'OPEN') throw Conflict('COUNT_NOT_OPEN', `Count is ${c.status}`);
    await this.prisma.$transaction(async (tx) => {
      for (const l of dto.lines) {
        const { count } = await tx.inventoryCountItem.updateMany({ where: { id: l.itemId, countId: id }, data: { countedQuantity: l.countedQuantity } });
        if (!count) throw NotFound('Count line', l.itemId);
      }
      const remaining = await tx.inventoryCountItem.count({ where: { countId: id, countedQuantity: null } });
      if (remaining === 0) await tx.inventoryCount.update({ where: { id }, data: { status: 'SUBMITTED' } });
    });
    return this.getCount(actor, id);
  }

  /**
   * Physical reconciliation. Variances are booked as COUNT_CORRECTION movements on
   * the AVAILABLE bucket. A shortfall larger than the unreserved stock cannot be
   * booked automatically (it would cut into customer reservations) and is returned
   * as an open discrepancy for manual resolution.
   */
  async reconcileCount(actor: AuthContext, id: string) {
    const c = await this.prisma.inventoryCount.findFirst({ where: { id, organizationId: actor.organizationId }, include: { items: true } });
    if (!c) throw NotFound('Count', id);
    assertWarehouseAccess(actor, c.warehouseId);
    if (c.status !== 'SUBMITTED') throw Conflict('COUNT_NOT_SUBMITTED', 'All lines must be counted before reconciliation');
    if (c.createdById === actor.id && !actor.isSuperAdmin) throw Forbidden('A different user must reconcile this count');

    return this.prisma.withRetry(async (tx) => {
      const claimed = await tx.inventoryCount.updateMany({ where: { id, status: 'SUBMITTED' }, data: { status: 'RECONCILED', reconciledById: actor.id, reconciledAt: new Date() } });
      if (!claimed.count) throw Conflict('COUNT_NOT_SUBMITTED', 'Count was reconciled concurrently');
      const corrections: any[] = [];
      const discrepancies: any[] = [];
      for (const item of c.items) {
        const bal = await tx.inventoryBalance.findUniqueOrThrow({ where: { batchId: item.batchId } });
        // Compare against live on-hand, so sales made during the count are accounted for.
        const variance = (item.countedQuantity ?? 0) - item.systemQuantity;
        if (variance === 0) continue;
        if (variance < 0 && -variance > bal.available) {
          discrepancies.push({ itemId: item.id, skuId: item.skuId, batchId: item.batchId, variance, available: bal.available, reserved: bal.reserved });
          continue;
        }
        await this.ledger.move(tx, {
          balanceId: bal.id, from: variance > 0 ? 'NONE' : 'AVAILABLE', to: variance > 0 ? 'AVAILABLE' : 'NONE',
          quantity: Math.abs(variance), type: 'COUNT_CORRECTION', referenceType: 'inventory_count', referenceId: id, actor,
          reason: `cycle count variance ${variance}`, idempotencyKey: `count:${item.id}`,
        });
        corrections.push({ skuId: item.skuId, batchId: item.batchId, variance });
      }
      await this.audit.record({ actor, action: 'inventory.count.reconcile', resourceType: 'inventory_count', resourceId: id, after: { corrections, discrepancies } }, tx);
      return { corrections, discrepancies };
    });
  }

  listCounts(actor: AuthContext, warehouseId?: string) {
    if (warehouseId) assertWarehouseAccess(actor, warehouseId);
    return this.prisma.inventoryCount.findMany({
      where: { organizationId: actor.organizationId, warehouseId, ...warehouseScopeFilter(actor) },
      include: { _count: { select: { items: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // -------------------------------------------------------------- transfers

  async createTransfer(actor: AuthContext, dto: CreateTransferDto) {
    if (dto.fromWarehouseId === dto.toWarehouseId) throw new DomainError('SAME_SITE', 'Source and destination must differ', 400);
    assertWarehouseAccess(actor, dto.fromWarehouseId);
    const sites = await this.prisma.warehouse.count({ where: { id: { in: [dto.fromWarehouseId, dto.toWarehouseId] }, organizationId: actor.organizationId } });
    if (sites !== 2) throw NotFound('Warehouse');
    const t = await this.prisma.stockTransfer.create({
      data: {
        organizationId: actor.organizationId, transferNumber: await nextDocNumber(this.prisma, 'TRF'), fromWarehouseId: dto.fromWarehouseId,
        toWarehouseId: dto.toWarehouseId, reason: dto.reason, createdById: actor.id,
        items: { create: dto.items.map((i) => ({ skuId: i.skuId, quantity: i.quantity })) },
      },
      include: { items: true },
    });
    await this.audit.record({ actor, action: 'transfer.create', resourceType: 'stock_transfer', resourceId: t.id, after: dto });
    return t;
  }

  /** Dispatch: FEFO-pick from source AVAILABLE and create IN_TRANSIT at destination, batch for batch. */
  async dispatchTransfer(actor: AuthContext, id: string) {
    const t = await this.prisma.stockTransfer.findFirst({ where: { id, organizationId: actor.organizationId }, include: { items: true } });
    if (!t) throw NotFound('Transfer', id);
    assertWarehouseAccess(actor, t.fromWarehouseId);
    return this.prisma.withRetry(async (tx) => {
      const claimed = await tx.stockTransfer.updateMany({ where: { id, status: { in: ['DRAFT', 'APPROVED'] } }, data: { status: 'DISPATCHED', dispatchedAt: new Date(), version: { increment: 1 } } });
      if (!claimed.count) throw Conflict('INVALID_TRANSFER_STATE', `Transfer is ${t.status}`);
      for (const item of t.items) {
        const lines = await this.ledger.allocateFefo(tx, t.fromWarehouseId, item.skuId, item.quantity);
        const allocations: any[] = [];
        for (const line of lines) {
          const srcBatch = await tx.inventoryBatch.findUniqueOrThrow({ where: { id: line.batchId } });
          await this.ledger.move(tx, {
            balanceId: line.balanceId, from: 'AVAILABLE', to: 'NONE', quantity: line.quantity, type: 'TRANSFER_OUT',
            referenceType: 'stock_transfer', referenceId: id, actor, idempotencyKey: `transfer-out:${item.id}:${line.batchId}`,
          });
          const dest = await this.ledger.ensureBatch(tx, {
            organizationId: t.organizationId, warehouseId: t.toWarehouseId, skuId: item.skuId, batchNumber: srcBatch.batchNumber,
            expiresAt: srcBatch.expiresAt, manufacturedAt: srcBatch.manufacturedAt, unitCost: srcBatch.unitCost,
          });
          await this.ledger.move(tx, {
            balanceId: dest.balance.id, from: 'NONE', to: 'IN_TRANSIT', quantity: line.quantity, type: 'TRANSFER_OUT',
            referenceType: 'stock_transfer', referenceId: id, actor, idempotencyKey: `transfer-transit:${item.id}:${line.batchId}`,
          });
          allocations.push({ destBalanceId: dest.balance.id, batchNumber: srcBatch.batchNumber, quantity: line.quantity });
        }
        await tx.stockTransferItem.update({ where: { id: item.id }, data: { dispatchedQty: item.quantity, allocations } });
      }
      await this.audit.record({ actor, action: 'transfer.dispatch', resourceType: 'stock_transfer', resourceId: id }, tx);
      return tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: { items: true } });
    });
  }

  /** Receive at destination: IN_TRANSIT -> AVAILABLE. Short receipts are written off and recorded. */
  async receiveTransfer(actor: AuthContext, id: string, dto: ReceiveTransferDto) {
    const t = await this.prisma.stockTransfer.findFirst({ where: { id, organizationId: actor.organizationId }, include: { items: true } });
    if (!t) throw NotFound('Transfer', id);
    assertWarehouseAccess(actor, t.toWarehouseId);
    return this.prisma.withRetry(async (tx) => {
      const claimed = await tx.stockTransfer.updateMany({ where: { id, status: 'DISPATCHED' }, data: { status: 'RECEIVED', receivedAt: new Date(), version: { increment: 1 } } });
      if (!claimed.count) throw Conflict('INVALID_TRANSFER_STATE', `Transfer is ${t.status}`);
      const shortages: any[] = [];
      for (const item of t.items) {
        const line = dto.lines.find((l) => l.itemId === item.id);
        let toReceive = Math.min(line?.receivedQty ?? item.dispatchedQty, item.dispatchedQty);
        if ((line?.receivedQty ?? 0) > item.dispatchedQty) throw new DomainError('OVER_RECEIPT', `Cannot receive more than dispatched for item ${item.id}`, 400);
        const received = toReceive;
        for (const alloc of (item.allocations as any[]) ?? []) {
          const take = Math.min(toReceive, alloc.quantity);
          if (take > 0) {
            await this.ledger.move(tx, {
              balanceId: alloc.destBalanceId, from: 'IN_TRANSIT', to: 'AVAILABLE', quantity: take, type: 'TRANSFER_IN',
              referenceType: 'stock_transfer', referenceId: id, actor, idempotencyKey: `transfer-in:${item.id}:${alloc.destBalanceId}`,
            });
          }
          if (alloc.quantity - take > 0) {
            await this.ledger.move(tx, {
              balanceId: alloc.destBalanceId, from: 'IN_TRANSIT', to: 'NONE', quantity: alloc.quantity - take, type: 'WRITE_OFF',
              referenceType: 'stock_transfer', referenceId: id, actor, reason: 'transfer shortage', idempotencyKey: `transfer-short:${item.id}:${alloc.destBalanceId}`,
            });
          }
          toReceive -= take;
        }
        await tx.stockTransferItem.update({ where: { id: item.id }, data: { receivedQty: received } });
        if (received < item.dispatchedQty) shortages.push({ itemId: item.id, skuId: item.skuId, short: item.dispatchedQty - received });
      }
      await this.audit.record({ actor, action: 'transfer.receive', resourceType: 'stock_transfer', resourceId: id, after: { shortages } }, tx);
      return { transfer: await tx.stockTransfer.findUniqueOrThrow({ where: { id }, include: { items: true } }), shortages };
    });
  }

  listTransfers(actor: AuthContext, status?: string) {
    const scope = actor.isSuperAdmin || actor.warehouseIds === null ? undefined : actor.warehouseIds;
    return this.prisma.stockTransfer.findMany({
      where: {
        organizationId: actor.organizationId,
        status: status as any,
        OR: scope ? [{ fromWarehouseId: { in: scope } }, { toWarehouseId: { in: scope } }] : undefined,
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  // ------------------------------------------------------------ background

  /** Moves unreserved stock of expired batches into the EXPIRED bucket and flags the batch. */
  async sweepExpiredBatches() {
    const batches = await this.prisma.inventoryBatch.findMany({
      where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
      include: { balance: true },
      take: 500,
    });
    let moved = 0;
    for (const b of batches) {
      await this.prisma.withRetry(async (tx) => {
        const bal = await tx.inventoryBalance.findUnique({ where: { batchId: b.id } });
        if (bal && bal.available > 0) {
          await this.ledger.move(tx, {
            balanceId: bal.id, from: 'AVAILABLE', to: 'EXPIRED', quantity: bal.available, type: 'EXPIRE',
            referenceType: 'expiry_sweep', referenceId: b.id, actor: SYSTEM_ACTOR(b.organizationId), idempotencyKey: `expire:${b.id}:${bal.version}`,
          });
          moved += bal.available;
        }
        // Keep ACTIVE while units are still reserved so open orders can be re-allocated by staff.
        if (!bal || bal.reserved === 0) await tx.inventoryBatch.update({ where: { id: b.id }, data: { status: 'EXPIRED' } });
      });
    }
    return { batches: batches.length, unitsExpired: moved };
  }

  /** Creates one low-stock notification per (site, SKU, day). */
  async raiseLowStockAlerts() {
    const rows = await this.prisma.$queryRaw<{ organization_id: string; warehouse_id: string; sku_id: string; code: string; name: string; available: number; reorder_point: number }[]>`
      SELECT b.organization_id, b.warehouse_id, b.sku_id, k.code, p.name, SUM(b.available)::int AS available, k.reorder_point
      FROM inventory_balances b JOIN skus k ON k.id = b.sku_id JOIN products p ON p.id = k.product_id
      WHERE k.status = 'ACTIVE'
      GROUP BY b.organization_id, b.warehouse_id, b.sku_id, k.code, p.name, k.reorder_point
      HAVING SUM(b.available) <= k.reorder_point`;
    const day = new Date().toISOString().slice(0, 10);
    const created = await this.prisma.notification.createMany({
      data: rows.map((r) => ({
        organizationId: r.organization_id, warehouseId: r.warehouse_id, recipientType: 'ROLE', recipientId: 'INVENTORY_MANAGER',
        category: 'LOW_STOCK', title: `Low stock: ${r.name} (${r.code})`,
        body: `${r.available} available, reorder point ${r.reorder_point}`,
        dedupeKey: `lowstock:${r.warehouse_id}:${r.sku_id}:${day}`,
      })),
      skipDuplicates: true,
    });
    return { candidates: rows.length, created: created.count };
  }

  private shapeCount(c: any, revealSystem = !c.blind) {
    return { ...c, items: c.items.map((i: any) => ({ ...i, systemQuantity: revealSystem || c.status !== 'OPEN' ? i.systemQuantity : undefined })) };
  }
}
