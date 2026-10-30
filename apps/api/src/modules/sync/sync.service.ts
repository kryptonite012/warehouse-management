import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ActorService } from '../../common/actor.service';
import { AuditService } from '../../common/audit.service';
import { assertWarehouseAccess, AuthContext, hasPermission } from '../../common/auth-context';
import { Conflict, DomainError, NotFound } from '../../common/errors';
import { PERMISSIONS } from '../../common/permissions';
import { PrismaService } from '../../common/prisma.service';
import { TokenService } from '../../common/token.service';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { InventoryService } from '../inventory/inventory.service';
import { OfflineOp, PushDto, RegisterDeviceDto, ResolveConflictDto, SyncOperationDto } from './sync.dto';

const REQUIRED: Record<OfflineOp, string> = {
  PICK_SCAN: PERMISSIONS.PICKING,
  DAMAGE_REPORT: PERMISSIONS.INVENTORY_QUALITY,
  COUNT_SUBMIT: PERMISSIONS.INVENTORY_COUNT,
  TRANSFER_RECEIVE: PERMISSIONS.INVENTORY_TRANSFER,
};

/**
 * Store-and-forward synchronisation for dark-store edge agents.
 *
 * Ownership: the central database owns every stock balance. The edge only submits
 * *intents* (scan these units, report this damage, these are my counts) — never
 * absolute quantities — so there is no last-write-wins on stock. Each operation:
 *   - is deduplicated by its client-generated id (exactly-once processing),
 *   - runs through the same business rules as online calls,
 *   - becomes a SyncConflict for manual reconciliation if those rules now reject it
 *     (e.g. the stock was sold centrally while the store was offline).
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger('Sync');

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly actors: ActorService,
    private readonly inventory: InventoryService,
    private readonly fulfillment: FulfillmentService,
    private readonly audit: AuditService,
  ) {}

  async registerDevice(actor: AuthContext, dto: RegisterDeviceDto) {
    assertWarehouseAccess(actor, dto.warehouseId);
    const wh = await this.prisma.warehouse.findFirst({ where: { id: dto.warehouseId, organizationId: actor.organizationId } });
    if (!wh) throw NotFound('Warehouse', dto.warehouseId);
    const { token, hash } = this.tokens.newOpaqueToken();
    const device = await this.prisma.edgeDevice.create({
      data: { organizationId: actor.organizationId, warehouseId: dto.warehouseId, name: dto.name, tokenHash: hash, allowedOps: dto.allowedOps },
    });
    await this.audit.record({ actor, action: 'sync.device_register', resourceType: 'edge_device', resourceId: device.id, after: dto });
    // The token is shown exactly once.
    return { id: device.id, warehouseId: device.warehouseId, allowedOps: device.allowedOps, token };
  }

  async revokeDevice(actor: AuthContext, id: string) {
    const d = await this.prisma.edgeDevice.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!d) throw NotFound('Device', id);
    assertWarehouseAccess(actor, d.warehouseId);
    await this.prisma.edgeDevice.update({ where: { id }, data: { active: false } });
    await this.audit.record({ actor, action: 'sync.device_revoke', resourceType: 'edge_device', resourceId: id });
  }

  async authenticateDevice(token: string | undefined) {
    if (!token) throw new UnauthorizedException('Missing device token');
    const device = await this.prisma.edgeDevice.findUnique({ where: { tokenHash: TokenService.hash(token) } });
    if (!device || !device.active) throw new UnauthorizedException('Unknown or revoked device');
    // Heartbeat timestamps need ~30 s resolution; writing them on every call would make
    // one hot row the serialization point for all concurrent pushes from a store.
    await this.touch(device.id, device.warehouseId);
    return device;
  }

  /** Local cache for the edge: catalog, barcodes, sellable stock and open tasks for this store. */
  async snapshot(token: string | undefined) {
    const device = await this.authenticateDevice(token);
    const storeId = device.warehouseId;
    const [skus, balances, tasks, counts, transfers] = await Promise.all([
      this.prisma.sku.findMany({
        where: { organizationId: device.organizationId, status: 'ACTIVE' },
        select: { id: true, code: true, product: { select: { name: true } }, barcodes: { select: { barcode: true } } },
      }),
      this.prisma.inventoryBalance.findMany({
        where: { warehouseId: storeId },
        select: { skuId: true, batchId: true, available: true, reserved: true, batch: { select: { batchNumber: true, expiresAt: true, status: true } } },
      }),
      this.prisma.pickingTask.findMany({ where: { warehouseId: storeId, status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] } }, include: { items: true } }),
      this.prisma.inventoryCount.findMany({ where: { warehouseId: storeId, status: 'OPEN' }, include: { items: { select: { id: true, skuId: true, batchId: true } } } }),
      this.prisma.stockTransfer.findMany({ where: { toWarehouseId: storeId, status: 'DISPATCHED' }, include: { items: true } }),
    ]);
    return {
      serverTime: new Date().toISOString(),
      deviceId: device.id,
      warehouseId: storeId,
      allowedOps: device.allowedOps,
      lastAcceptedSequence: Number(device.lastSequence),
      // Advisory only while offline: global accuracy is not guaranteed during isolation.
      inventoryIsAdvisory: true,
      skus: skus.map((s) => ({ id: s.id, code: s.code, name: s.product.name, barcodes: s.barcodes.map((b) => b.barcode) })),
      balances,
      pickingTasks: tasks,
      openCounts: counts,
      inboundTransfers: transfers,
    };
  }

  async push(token: string | undefined, dto: PushDto) {
    const device = await this.authenticateDevice(token);
    const ops = [...dto.operations].sort((a, b) => a.sequence - b.sequence);
    const results = [];
    let maxSeq = Number(device.lastSequence);
    for (const op of ops) {
      results.push(await this.applyOne(device, op));
      maxSeq = Math.max(maxSeq, op.sequence);
    }
    // Monotonic: concurrent pushes can only move the high-water mark forward.
    await this.prisma.$executeRaw`UPDATE edge_devices SET last_sequence = ${BigInt(maxSeq)} WHERE id = ${device.id}::uuid AND last_sequence < ${BigInt(maxSeq)}`;
    return { accepted: results.filter((r) => r.status === 'APPLIED').length, results, lastAcceptedSequence: maxSeq };
  }

  private async applyOne(device: { id: string; organizationId: string; warehouseId: string; allowedOps: string[] }, op: SyncOperationDto) {
    // Exactly-once: the first writer of clientOpId owns the operation.
    const existing = await this.prisma.syncOperation.findUnique({ where: { clientOpId: op.clientOpId } });
    if (existing) return { clientOpId: op.clientOpId, status: existing.status, duplicate: true, message: existing.resultMessage };

    const base = {
      deviceId: device.id, warehouseId: device.warehouseId, clientOpId: op.clientOpId, sequence: BigInt(op.sequence),
      opType: op.opType, payload: { ...op.payload, performedBy: op.performedBy }, occurredAt: new Date(op.occurredAt),
    };
    let row;
    try {
      row = await this.prisma.syncOperation.create({ data: { ...base, status: 'PROCESSING' } });
    } catch (e: any) {
      if (e?.code === 'P2002') return { clientOpId: op.clientOpId, status: 'PROCESSING', duplicate: true };
      throw e;
    }

    const finish = (status: string, message?: string) =>
      this.prisma.syncOperation.update({ where: { id: row.id }, data: { status, resultMessage: message } }).then(() => ({ clientOpId: op.clientOpId, status, message }));

    if (!device.allowedOps.includes(op.opType)) return finish('REJECTED', `Operation ${op.opType} is not permitted offline for this device`);

    let actor: AuthContext;
    try {
      actor = await this.actors.load('employee', op.performedBy, device.organizationId);
      assertWarehouseAccess(actor, device.warehouseId);
      if (!hasPermission(actor, REQUIRED[op.opType])) throw new DomainError('FORBIDDEN', `User lacks ${REQUIRED[op.opType]}`, 403);
    } catch (e: any) {
      await this.audit.record({
        actor: { kind: 'edge-device', id: device.id, organizationId: device.organizationId, isSuperAdmin: false, permissions: new Set(), warehouseIds: [device.warehouseId] },
        action: `sync.${op.opType.toLowerCase()}`, resourceType: 'sync_operation', resourceId: row.id, outcome: 'DENIED', after: { performedBy: op.performedBy, reason: e.message },
      });
      return finish('REJECTED', e.message);
    }

    try {
      const p = op.payload;
      switch (op.opType) {
        case 'PICK_SCAN':
          await this.fulfillment.scan(actor, p.taskId, { itemId: p.itemId, barcode: p.barcode, quantity: p.quantity });
          break;
        case 'DAMAGE_REPORT':
          await this.inventory.changeStatus(actor, device.warehouseId, {
            batchId: p.batchId, action: 'DAMAGE', quantity: p.quantity, reason: `offline: ${p.reason ?? 'damaged'}`, idempotencyKey: op.clientOpId,
          });
          break;
        case 'COUNT_SUBMIT':
          await this.inventory.submitCount(actor, p.countId, { lines: p.lines });
          break;
        case 'TRANSFER_RECEIVE':
          await this.inventory.receiveTransfer(actor, p.transferId, { lines: p.lines });
          break;
      }
      return finish('APPLIED');
    } catch (e: any) {
      const code = e?.code ?? 'ERROR';
      await this.prisma.syncConflict.create({
        data: {
          organizationId: device.organizationId, warehouseId: device.warehouseId, syncOperationId: row.id, conflictType: code,
          details: { opType: op.opType, payload: op.payload, error: e.message, occurredAt: op.occurredAt },
        },
      });
      this.logger.warn(`sync conflict ${op.clientOpId}: ${e.message}`);
      return finish('CONFLICT', e.message);
    }
  }

  private async touch(deviceId: string, warehouseId: string) {
    const stale = new Date(Date.now() - 30_000);
    await this.prisma.edgeDevice.updateMany({ where: { id: deviceId, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: stale } }] }, data: { lastSeenAt: new Date() } });
    await this.prisma.darkStore.updateMany({ where: { id: warehouseId, OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: stale } }] }, data: { lastSyncAt: new Date() } });
  }

  listConflicts(actor: AuthContext, warehouseId?: string, status = 'OPEN') {
    if (warehouseId) assertWarehouseAccess(actor, warehouseId);
    return this.prisma.syncConflict.findMany({
      where: {
        organizationId: actor.organizationId, warehouseId, status,
        ...(actor.isSuperAdmin || actor.warehouseIds === null ? {} : { warehouseId: { in: actor.warehouseIds } }),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** Manual reconciliation: dismiss (accept central state) or retry the original intent. */
  async resolveConflict(actor: AuthContext, id: string, dto: ResolveConflictDto) {
    const c = await this.prisma.syncConflict.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!c) throw NotFound('Conflict', id);
    assertWarehouseAccess(actor, c.warehouseId);
    if (c.status !== 'OPEN') throw Conflict('ALREADY_RESOLVED', `Conflict is ${c.status}`);
    let outcome = 'dismissed';
    if (dto.action === 'RETRY') {
      const op = await this.prisma.syncOperation.findUniqueOrThrow({ where: { id: c.syncOperationId } });
      const device = await this.prisma.edgeDevice.findUniqueOrThrow({ where: { id: op.deviceId } });
      const payload = op.payload as any;
      await this.prisma.syncOperation.update({ where: { id: op.id }, data: { clientOpId: `${op.clientOpId}:retry:${Date.now()}` } });
      const res = await this.applyOne(device, {
        clientOpId: op.clientOpId, sequence: Number(op.sequence), opType: op.opType as OfflineOp, occurredAt: op.occurredAt.toISOString(),
        performedBy: payload.performedBy, payload,
      });
      if (res.status !== 'APPLIED') throw Conflict('RETRY_FAILED', `Retry failed: ${res.message}`);
      outcome = 'applied on retry';
    }
    await this.prisma.syncConflict.update({ where: { id }, data: { status: dto.action === 'RETRY' ? 'RESOLVED' : 'DISMISSED', resolvedById: actor.id, resolution: `${outcome}: ${dto.note}`, resolvedAt: new Date() } });
    await this.audit.record({ actor, action: 'sync.conflict_resolve', resourceType: 'sync_conflict', resourceId: id, after: dto });
    return { id, outcome };
  }

  async status(actor: AuthContext) {
    return this.prisma.$queryRaw`
      SELECT w.id, w.code, w.name, d.last_sync_at AS "lastSyncAt",
        (SELECT MAX(e.last_seen_at) FROM edge_devices e WHERE e.warehouse_id = w.id AND e.active) AS "lastDeviceSeenAt",
        (SELECT COUNT(*) FROM edge_devices e WHERE e.warehouse_id = w.id AND e.active)::int AS devices,
        (SELECT COUNT(*) FROM sync_conflicts c WHERE c.warehouse_id = w.id AND c.status = 'OPEN')::int AS "openConflicts",
        (SELECT COUNT(*) FROM sync_operations o WHERE o.warehouse_id = w.id AND o.received_at >= now() - interval '24 hours')::int AS "opsLast24h"
      FROM warehouses w JOIN dark_stores d ON d.id = w.id
      WHERE w.organization_id = ${actor.organizationId}::uuid
        ${actor.isSuperAdmin || actor.warehouseIds === null ? Prisma.empty : Prisma.sql`AND w.id = ANY(${actor.warehouseIds}::uuid[])`}
      ORDER BY w.code`;
  }
}
