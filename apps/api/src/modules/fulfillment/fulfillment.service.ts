import { Injectable } from '@nestjs/common';
import { randomInt, randomUUID } from 'crypto';
import { AuditService } from '../../common/audit.service';
import { assertWarehouseAccess, AuthContext, warehouseScopeFilter } from '../../common/auth-context';
import { nextDocNumber } from '../../common/doc-number';
import { Conflict, DomainError, Forbidden, NotFound } from '../../common/errors';
import { PrismaService, Tx } from '../../common/prisma.service';
import { ReservationService } from '../inventory/reservation.service';
import { OrderStateService } from '../orders/order-state.service';
import { CompletePackDto, CompletePickDto, CreateWaveDto, ScanDto, TaskQuery } from './fulfillment.dto';

@Injectable()
export class FulfillmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: OrderStateService,
    private readonly reservations: ReservationService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- picking

  /**
   * Builds a pick list from the order's reservation lines (so the picker is sent to
   * exactly the FEFO batches that were reserved) and sorts it by the bin pick sequence
   * generated from the warehouse layout (serpentine route).
   */
  async createPickingTask(actor: AuthContext, orderId: string, waveId?: string, mode = 'SINGLE_ORDER', assignToId?: string, txIn?: Tx) {
    const run = async (tx: Tx) => {
      const order = await tx.order.findFirst({ where: { id: orderId, organizationId: actor.organizationId }, include: { items: true } });
      if (!order) throw NotFound('Order', orderId);
      assertWarehouseAccess(actor, order.darkStoreId);
      if (order.status !== 'ACCEPTED') throw Conflict('ORDER_NOT_READY', `Order is ${order.status}; only ACCEPTED orders can be picked`);
      const reservation = await tx.inventoryReservation.findFirst({ where: { id: order.reservationId ?? undefined, status: 'ACTIVE' }, include: { lines: true } });
      if (!reservation) throw Conflict('NO_ACTIVE_RESERVATION', 'Order has no active stock reservation');

      const locs = await tx.skuLocation.findMany({
        where: { warehouseId: order.darkStoreId, skuId: { in: reservation.lines.map((l) => l.skuId) } },
        include: { location: true },
        orderBy: { isPrimary: 'desc' },
      });
      const items = reservation.lines.map((l) => {
        const loc = locs.find((x) => x.skuId === l.skuId);
        const orderItem = order.items.find((i) => i.skuId === l.skuId)!;
        return {
          orderItemId: orderItem.id, skuId: l.skuId, batchId: l.batchId, quantity: l.quantity,
          locationCode: loc?.location.fullCode ?? null, pickSequence: loc?.location.pickSequence ?? 999_999_999,
        };
      });
      items.sort((a, b) => a.pickSequence - b.pickSequence);

      const task = await tx.pickingTask.create({
        data: {
          organizationId: order.organizationId, warehouseId: order.darkStoreId, orderId, taskNumber: await nextDocNumber(tx, 'PICK'),
          mode, waveId, assignedToId: assignToId, status: assignToId ? 'ASSIGNED' : 'PENDING',
          items: { create: items },
        },
        include: { items: true },
      });
      await this.state.transition(tx, orderId, 'PICKING', actor, 'picking.task_created');
      return task;
    };
    return txIn ? run(txIn) : this.prisma.withRetry(run);
  }

  /** Batch / wave picking: several orders, one picker, one merged route. */
  async createWave(actor: AuthContext, dto: CreateWaveDto) {
    const waveId = randomUUID();
    const tasks = await this.prisma.withRetry(async (tx) => {
      const created = [];
      for (const orderId of dto.orderIds) created.push(await this.createPickingTask(actor, orderId, waveId, dto.mode ?? 'BATCH', dto.assignToId, tx));
      return created;
    });
    return { waveId, tasks: tasks.map((t) => t.id), route: await this.waveRoute(actor, waveId) };
  }

  async waveRoute(actor: AuthContext, waveId: string) {
    const tasks = await this.prisma.pickingTask.findMany({ where: { waveId, organizationId: actor.organizationId }, include: { items: true } });
    if (!tasks.length) throw NotFound('Wave', waveId);
    const stops = tasks.flatMap((t) => t.items.map((i) => ({ ...i, orderId: t.orderId, taskId: t.id })));
    stops.sort((a, b) => a.pickSequence - b.pickSequence);
    return this.decorate(stops);
  }

  async listTasks(actor: AuthContext, q: TaskQuery) {
    if (q.warehouseId) assertWarehouseAccess(actor, q.warehouseId);
    const tasks = await this.prisma.pickingTask.findMany({
      where: {
        organizationId: actor.organizationId, warehouseId: q.warehouseId, status: q.status as any,
        assignedToId: q.assigned === 'me' ? actor.id : undefined, ...warehouseScopeFilter(actor),
      },
      include: { items: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    const orders = await this.prisma.order.findMany({ where: { id: { in: tasks.map((t) => t.orderId) } }, select: { id: true, orderNumber: true, placedAt: true } });
    return Promise.all(tasks.map(async (t) => ({ ...t, order: orders.find((o) => o.id === t.orderId), items: await this.decorate(t.items) })));
  }

  async getTask(actor: AuthContext, id: string) {
    const t = await this.prisma.pickingTask.findFirst({ where: { id, organizationId: actor.organizationId }, include: { items: true } });
    if (!t) throw NotFound('Picking task', id);
    assertWarehouseAccess(actor, t.warehouseId);
    return { ...t, items: await this.decorate(t.items) };
  }

  async claim(actor: AuthContext, id: string) {
    const t = await this.getTask(actor, id);
    const { count } = await this.prisma.pickingTask.updateMany({
      where: { id, OR: [{ status: 'PENDING' }, { status: 'ASSIGNED', assignedToId: actor.id }] },
      data: { status: 'IN_PROGRESS', assignedToId: actor.id, startedAt: new Date() },
    });
    if (!count) throw Conflict('TASK_UNAVAILABLE', `Task is ${t.status}${t.assignedToId ? ' and assigned to someone else' : ''}`);
    return this.getTask(actor, id);
  }

  /**
   * Scan verification: barcode must belong to the line's SKU, and the reserved batch
   * must not have expired since reservation (FEFO + expiry validation at pick time).
   */
  async scan(actor: AuthContext, id: string, dto: ScanDto) {
    const t = await this.getTask(actor, id);
    this.assertPicker(actor, t);
    const item = t.items.find((i: any) => i.id === dto.itemId);
    if (!item) throw NotFound('Pick line', dto.itemId);
    const barcode = await this.prisma.productBarcode.findUnique({ where: { organizationId_barcode: { organizationId: actor.organizationId, barcode: dto.barcode } } });
    if (!barcode || barcode.skuId !== item.skuId) {
      await this.audit.record({ actor, action: 'picking.scan_mismatch', resourceType: 'picking_task', resourceId: id, outcome: 'FAILED', after: dto });
      throw new DomainError('WRONG_ITEM', 'Scanned barcode does not match this pick line', 422);
    }
    const batch = await this.prisma.inventoryBatch.findUniqueOrThrow({ where: { id: item.batchId } });
    if (batch.status !== 'ACTIVE' || (batch.expiresAt && batch.expiresAt <= new Date())) {
      throw new DomainError('BATCH_EXPIRED', `Batch ${batch.batchNumber} is expired or blocked; do not pick it. Ask a supervisor to re-allocate.`, 422);
    }
    if (item.pickedQty + dto.quantity > item.quantity) throw new DomainError('OVER_PICK', `Only ${item.quantity - item.pickedQty} more units needed`, 422);
    await this.prisma.pickingItem.update({
      where: { id: item.id },
      data: { pickedQty: { increment: dto.quantity }, verified: true, scannedBarcode: dto.barcode, pickedAt: new Date() },
    });
    return this.getTask(actor, id);
  }

  async completePicking(actor: AuthContext, id: string, dto: CompletePickDto) {
    const t = await this.getTask(actor, id);
    this.assertPicker(actor, t);
    const requireScan = await this.setting(actor.organizationId, 'fulfillment.require_barcode_scan', true);
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: t.orderId } });

    return this.prisma.withRetry(async (tx) => {
      const claimed = await tx.pickingTask.updateMany({ where: { id, status: 'IN_PROGRESS' }, data: { status: 'COMPLETED', completedAt: new Date() } });
      if (!claimed.count) throw Conflict('TASK_NOT_IN_PROGRESS', 'Task must be claimed and in progress');

      const resLines = await tx.inventoryReservationLine.findMany({ where: { reservationId: order.reservationId! } });
      const picked = new Map<string, number>();
      let short = false;
      for (const item of t.items as any[]) {
        const override = dto.shortPicks?.find((s) => s.itemId === item.id);
        const qty = override ? Math.min(override.pickedQty, item.quantity) : item.pickedQty;
        if (requireScan && qty > 0 && !item.verified) throw new DomainError('SCAN_REQUIRED', `Line ${item.sku.code} must be scanned before completion`, 422);
        if (override) await tx.pickingItem.update({ where: { id: item.id }, data: { pickedQty: qty } });
        if (qty < item.quantity) short = true;
        const line = resLines.find((l) => l.batchId === item.batchId && l.skuId === item.skuId)!;
        picked.set(line.id, (picked.get(line.id) ?? 0) + qty);
        await tx.orderItem.update({ where: { id: item.orderItemId }, data: { pickedQty: { increment: qty } } });
      }
      await this.reservations.consume(tx, actor, order.reservationId!, picked, id);
      const totalPicked = [...picked.values()].reduce((a, b) => a + b, 0);
      if (totalPicked === 0) {
        await this.state.transition(tx, order.id, 'CANCELLED', actor, 'picking.nothing_found', 'no stock found at pick');
      } else {
        await this.state.transition(tx, order.id, short ? 'PARTIALLY_FULFILLED' : 'PICKED', actor, 'picking.completed');
        await tx.packingTask.create({ data: { organizationId: order.organizationId, warehouseId: order.darkStoreId, orderId: order.id } });
      }
      await this.audit.record({ actor, action: 'picking.complete', resourceType: 'picking_task', resourceId: id, after: { short, totalPicked } }, tx);
      return { taskId: id, short, totalPicked };
    });
  }

  // ---------------------------------------------------------------- packing

  async listPacking(actor: AuthContext, q: TaskQuery) {
    if (q.warehouseId) assertWarehouseAccess(actor, q.warehouseId);
    return this.prisma.packingTask.findMany({
      where: { organizationId: actor.organizationId, warehouseId: q.warehouseId, status: q.status as any, ...warehouseScopeFilter(actor) },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
  }

  async createPacking(actor: AuthContext, orderId: string) {
    const order = await this.prisma.order.findFirst({ where: { id: orderId, organizationId: actor.organizationId } });
    if (!order) throw NotFound('Order', orderId);
    assertWarehouseAccess(actor, order.darkStoreId);
    if (!['PICKED', 'PARTIALLY_FULFILLED'].includes(order.status)) throw Conflict('ORDER_NOT_PICKED', `Order is ${order.status}`);
    return this.prisma.packingTask.upsert({
      where: { orderId },
      create: { organizationId: order.organizationId, warehouseId: order.darkStoreId, orderId },
      update: {},
    });
  }

  /** Validates packed quantities against picked quantities, then labels and stages the order. */
  async completePacking(actor: AuthContext, id: string, dto: CompletePackDto) {
    const task = await this.prisma.packingTask.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!task) throw NotFound('Packing task', id);
    assertWarehouseAccess(actor, task.warehouseId);
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: task.orderId }, include: { items: true } });
    const mismatches = order.items
      .map((i) => ({ orderItemId: i.id, sku: i.skuCode, picked: i.pickedQty, packed: dto.lines.find((l) => l.orderItemId === i.id)?.quantity ?? 0 }))
      .filter((m) => m.picked !== m.packed);
    if (mismatches.length) throw new DomainError('PACK_MISMATCH', 'Packed quantities do not match picked quantities', 422, mismatches);

    return this.prisma.withRetry(async (tx) => {
      const label = `PKG-${order.orderNumber}`;
      const claimed = await tx.packingTask.updateMany({
        where: { id, status: { in: ['PENDING', 'IN_PROGRESS'] } },
        data: { status: 'COMPLETED', packagingType: dto.packagingType, labelCode: label, packedById: actor.id, completedAt: new Date() },
      });
      if (!claimed.count) throw Conflict('ALREADY_PACKED', 'Packing task is already complete');
      await this.state.transition(tx, order.id, 'PACKING', actor, 'packing.started');
      await this.state.transition(tx, order.id, 'PACKED', actor, 'packing.completed');
      await this.state.transition(tx, order.id, 'READY_FOR_DISPATCH', actor, 'dispatch.staged');
      await tx.order.update({ where: { id: order.id }, data: { deliveryOtp: String(randomInt(1000, 10000)) } });
      return { taskId: id, labelCode: label, status: 'READY_FOR_DISPATCH' };
    });
  }

  async packingLabel(actor: AuthContext, id: string) {
    const task = await this.prisma.packingTask.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!task?.labelCode) throw NotFound('Packing label', id);
    assertWarehouseAccess(actor, task.warehouseId);
    const order = await this.prisma.order.findUniqueOrThrow({ where: { id: task.orderId }, include: { items: true } });
    const a = order.addressSnapshot as any;
    return {
      labelCode: task.labelCode, orderNumber: order.orderNumber, packagingType: task.packagingType,
      deliverTo: { line1: a.line1, line2: a.line2, city: a.city, postalCode: a.postalCode },
      itemCount: order.items.reduce((s, i) => s + i.pickedQty, 0), paymentMethod: order.paymentMethod,
      codAmount: order.paymentMethod === 'COD' ? order.total : null,
      barcodeUrl: `/api/v1/labels/barcode.svg?text=${encodeURIComponent(task.labelCode)}`,
    };
  }

  // ---------------------------------------------------------------- helpers

  private assertPicker(actor: AuthContext, t: { assignedToId: string | null; status: string }) {
    if (t.assignedToId && t.assignedToId !== actor.id && !actor.isSuperAdmin) throw Forbidden('This task is assigned to another picker');
  }

  private async decorate(items: any[]) {
    const skus = await this.prisma.sku.findMany({
      where: { id: { in: [...new Set(items.map((i) => i.skuId))] } },
      include: { product: { select: { name: true, images: { take: 1, select: { url: true } } } }, barcodes: { where: { isPrimary: true } } },
    });
    const batches = await this.prisma.inventoryBatch.findMany({ where: { id: { in: items.map((i) => i.batchId) } } });
    return items.map((i) => {
      const s = skus.find((k) => k.id === i.skuId)!;
      const b = batches.find((x) => x.id === i.batchId);
      return {
        ...i,
        sku: { code: s.code, name: s.product.name, image: s.product.images[0]?.url ?? null, barcode: s.barcodes[0]?.barcode ?? null },
        batch: b ? { number: b.batchNumber, expiresAt: b.expiresAt } : null,
      };
    });
  }

  private async setting<T>(orgId: string, key: string, fallback: T): Promise<T> {
    const s = await this.prisma.systemSetting.findFirst({ where: { organizationId: orgId, key } });
    return (s?.value as T) ?? fallback;
  }
}
