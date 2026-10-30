import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { assertWarehouseAccess, AuthContext, warehouseScopeFilter } from '../../common/auth-context';
import { Conflict, DomainError, NotFound } from '../../common/errors';
import { pageArgs, toPage } from '../../common/pagination';
import { PrismaService, Tx } from '../../common/prisma.service';
import {
  AssignSkuLocationDto, BulkLayoutDto, CreateLocationDto, CreateWarehouseDto, UpdateLocationDto, UpdateWarehouseDto, WarehouseListQuery,
} from './warehouses.dto';

const PARENT_LEVEL: Record<string, string | null> = { ZONE: null, AISLE: 'ZONE', RACK: 'AISLE', SHELF: 'RACK', BIN: 'SHELF' };

@Injectable()
export class WarehousesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(actor: AuthContext, q: WarehouseListQuery, forceType?: string) {
    const where: Prisma.WarehouseWhereInput = {
      organizationId: actor.organizationId,
      deletedAt: null,
      type: (forceType ?? q.type) as any,
      status: q.status as any,
      regionId: q.regionId,
      ...warehouseScopeFilter(actor, 'id'),
      OR: q.search
        ? [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }, { city: { contains: q.search, mode: 'insensitive' } }]
        : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.warehouse.findMany({ where, include: { darkStore: true, region: true }, ...pageArgs(q, ['name', 'code', 'createdAt', 'city'], 'name') }),
      this.prisma.warehouse.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  async get(actor: AuthContext, id: string) {
    assertWarehouseAccess(actor, id);
    const w = await this.prisma.warehouse.findFirst({
      where: { id, organizationId: actor.organizationId, deletedAt: null },
      include: { darkStore: true, region: true },
    });
    if (!w) throw NotFound('Warehouse', id);
    return w;
  }

  async create(actor: AuthContext, dto: CreateWarehouseDto) {
    const { darkStore, ...data } = dto;
    if (dto.type === 'DARK_STORE' && dto.latitude === undefined) {
      throw new DomainError('VALIDATION_FAILED', 'Dark stores require GPS coordinates for serviceability', 400);
    }
    return this.prisma.$transaction(async (tx) => {
      const w = await tx.warehouse.create({
        data: {
          ...data,
          organizationId: actor.organizationId,
          temperatureZones: dto.temperatureZones ?? ['AMBIENT'],
          darkStore: dto.type === 'DARK_STORE' ? { create: { ...(darkStore ?? {}) } } : undefined,
        },
        include: { darkStore: true },
      });
      await this.audit.record({ actor, action: 'warehouse.create', resourceType: 'warehouse', resourceId: w.id, after: dto }, tx);
      return w;
    });
  }

  async update(actor: AuthContext, id: string, dto: UpdateWarehouseDto) {
    const before = await this.get(actor, id);
    const { version, darkStore, ...data } = dto;
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.warehouse.updateMany({
        where: { id, version },
        data: { ...data, version: { increment: 1 } },
      });
      if (!count) throw Conflict('STALE_VERSION', 'Warehouse was modified by someone else. Reload and retry.', { currentVersion: before.version });
      if (darkStore) {
        if (before.type !== 'DARK_STORE') throw new DomainError('NOT_A_DARK_STORE', 'Dark store settings only apply to dark stores', 400);
        await tx.darkStore.update({ where: { id }, data: darkStore });
      }
      await this.audit.record({ actor, action: 'warehouse.update', resourceType: 'warehouse', resourceId: id, before, after: dto }, tx);
      return tx.warehouse.findUniqueOrThrow({ where: { id }, include: { darkStore: true } });
    });
  }

  // ------------------------------------------------------------------ layout

  /** Full location tree with per-node occupancy for the visual layout view. */
  async layout(actor: AuthContext, warehouseId: string) {
    const wh = await this.get(actor, warehouseId);
    const locations = await this.prisma.storageLocation.findMany({
      where: { warehouseId },
      orderBy: [{ level: 'asc' }, { fullCode: 'asc' }],
      include: { skuAssignments: { select: { skuId: true } } },
    });
    const byParent = new Map<string | null, any[]>();
    for (const l of locations) {
      const node = {
        id: l.id, level: l.level, code: l.code, fullCode: l.fullCode, barcode: l.barcode, state: l.state,
        temperatureZone: l.temperatureZone, capacityUnits: l.capacityUnits, occupiedUnits: l.occupiedUnits,
        pickSequence: l.pickSequence, assignedSkus: l.skuAssignments.length,
        occupancy: l.occupiedUnits > 0 ? 'OCCUPIED' : l.skuAssignments.length ? 'ASSIGNED' : 'EMPTY',
        children: [] as any[],
      };
      const list = byParent.get(l.parentId) ?? [];
      list.push(node);
      byParent.set(l.parentId, list);
    }
    const attach = (node: any) => {
      node.children = (byParent.get(node.id) ?? []).map(attach);
      return node;
    };
    const tree = (byParent.get(null) ?? []).map(attach);
    const bins = locations.filter((l) => l.level === 'BIN');
    const capacity = bins.reduce((s, b) => s + (b.capacityUnits ?? 0), 0);
    const occupied = bins.reduce((s, b) => s + b.occupiedUnits, 0);
    return {
      warehouse: { id: wh.id, code: wh.code, name: wh.name, type: wh.type },
      summary: {
        bins: bins.length,
        emptyBins: bins.filter((b) => b.occupiedUnits === 0).length,
        restrictedBins: bins.filter((b) => b.state === 'RESTRICTED' || b.state === 'BLOCKED').length,
        reservedBins: bins.filter((b) => b.state === 'RESERVED').length,
        capacityUnits: capacity,
        occupiedUnits: occupied,
        utilization: capacity ? Number((occupied / capacity).toFixed(4)) : null,
      },
      tree,
    };
  }

  async createLocation(actor: AuthContext, warehouseId: string, dto: CreateLocationDto) {
    const wh = await this.get(actor, warehouseId);
    return this.prisma.$transaction((tx) => this.insertLocation(tx, actor, wh, dto));
  }

  /** Generates a full zone > aisle > rack > shelf > bin grid in one transaction. */
  async bulkLayout(actor: AuthContext, warehouseId: string, dto: BulkLayoutDto) {
    const wh = await this.get(actor, warehouseId);
    const temp = dto.temperatureZone ?? 'AMBIENT';
    let created = 0;
    let seq = 0;
    // Zones are walked in creation order; within a zone the route snakes through aisles.
    const zoneIndex = await this.prisma.storageLocation.count({ where: { warehouseId, level: 'ZONE' } });
    await this.prisma.$transaction(
      async (tx) => {
        const zone = await this.insertLocation(tx, actor, wh, { level: 'ZONE', code: dto.zoneCode, temperatureZone: temp });
        created++;
        for (let a = 1; a <= dto.aisles; a++) {
          const aisle = await this.insertLocation(tx, actor, wh, { level: 'AISLE', code: String(a).padStart(2, '0'), parentId: zone.id, temperatureZone: temp });
          created++;
          for (let r = 1; r <= dto.racksPerAisle; r++) {
            const rack = await this.insertLocation(tx, actor, wh, { level: 'RACK', code: String(r).padStart(2, '0'), parentId: aisle.id, temperatureZone: temp });
            created++;
            for (let s = 1; s <= dto.shelvesPerRack; s++) {
              const shelf = await this.insertLocation(tx, actor, wh, { level: 'SHELF', code: String(s), parentId: rack.id, temperatureZone: temp });
              created++;
              for (let b = 1; b <= dto.binsPerShelf; b++) {
                // Serpentine pick sequence: odd aisles walk up, even aisles walk down.
                const rackOrder = a % 2 === 1 ? r : dto.racksPerAisle - r + 1;
                seq = zoneIndex * 60_000_000 + a * 1_000_000 + rackOrder * 10_000 + s * 100 + b;
                await this.insertLocation(tx, actor, wh, {
                  level: 'BIN', code: String(b).padStart(2, '0'), parentId: shelf.id, temperatureZone: temp,
                  capacityUnits: dto.binCapacityUnits, pickSequence: seq,
                });
                created++;
              }
            }
          }
        }
      },
      { timeout: 60_000 },
    );
    await this.audit.record({ actor, action: 'layout.bulk_create', resourceType: 'warehouse', resourceId: warehouseId, after: { ...dto, created } });
    return { created };
  }

  async updateLocation(actor: AuthContext, warehouseId: string, locationId: string, dto: UpdateLocationDto) {
    await this.get(actor, warehouseId);
    const loc = await this.prisma.storageLocation.findFirst({ where: { id: locationId, warehouseId } });
    if (!loc) throw NotFound('Location', locationId);
    if (dto.capacityUnits !== undefined && dto.capacityUnits < loc.occupiedUnits) {
      throw new DomainError('CAPACITY_BELOW_OCCUPANCY', `Location holds ${loc.occupiedUnits} units; capacity cannot be lower`);
    }
    const updated = await this.prisma.storageLocation.update({ where: { id: locationId }, data: dto });
    await this.audit.record({ actor, action: 'location.update', resourceType: 'storage_location', resourceId: locationId, before: loc, after: dto });
    return updated;
  }

  /** Validates temperature compatibility between product and bin before assignment. */
  async assignSku(actor: AuthContext, warehouseId: string, dto: AssignSkuLocationDto) {
    await this.get(actor, warehouseId);
    const [loc, sku] = await Promise.all([
      this.prisma.storageLocation.findFirst({ where: { id: dto.locationId, warehouseId } }),
      this.prisma.sku.findFirst({ where: { id: dto.skuId, organizationId: actor.organizationId }, include: { product: true } }),
    ]);
    if (!loc) throw NotFound('Location', dto.locationId);
    if (!sku) throw NotFound('SKU', dto.skuId);
    if (loc.level !== 'BIN') throw new DomainError('NOT_A_BIN', 'Products can only be assigned to bins');
    if (loc.state === 'BLOCKED' || loc.state === 'RESTRICTED') throw new DomainError('LOCATION_UNAVAILABLE', `Location is ${loc.state}`);
    if (loc.temperatureZone !== sku.product.storageCondition) {
      throw new DomainError(
        'STORAGE_INCOMPATIBLE',
        `${sku.product.name} requires ${sku.product.storageCondition} storage but ${loc.fullCode} is ${loc.temperatureZone}`,
      );
    }
    return this.prisma.skuLocation.upsert({
      where: { skuId_locationId: { skuId: dto.skuId, locationId: dto.locationId } },
      create: { skuId: dto.skuId, locationId: dto.locationId, warehouseId, isPrimary: dto.isPrimary ?? true },
      update: { isPrimary: dto.isPrimary ?? true },
    });
  }

  async findByBarcode(actor: AuthContext, barcode: string) {
    const loc = await this.prisma.storageLocation.findFirst({
      where: { barcode, organizationId: actor.organizationId },
      include: { skuAssignments: { include: { sku: { include: { product: { select: { name: true } } } } } } },
    });
    if (!loc) throw NotFound('Location barcode', barcode);
    assertWarehouseAccess(actor, loc.warehouseId);
    return loc;
  }

  private async insertLocation(tx: Tx, actor: AuthContext, wh: { id: string; code: string }, dto: CreateLocationDto) {
    let fullCode = dto.code;
    if (dto.parentId) {
      const parent = await tx.storageLocation.findFirst({ where: { id: dto.parentId, warehouseId: wh.id } });
      if (!parent) throw NotFound('Parent location', dto.parentId);
      if (PARENT_LEVEL[dto.level] !== parent.level) {
        throw new DomainError('INVALID_HIERARCHY', `A ${dto.level} must be placed under a ${PARENT_LEVEL[dto.level]}, not a ${parent.level}`, 400);
      }
      fullCode = `${parent.fullCode}-${dto.code}`;
    } else if (dto.level !== 'ZONE') {
      throw new DomainError('INVALID_HIERARCHY', `A ${dto.level} needs a parent location`, 400);
    }
    return tx.storageLocation.create({
      data: {
        organizationId: actor.organizationId,
        warehouseId: wh.id,
        parentId: dto.parentId,
        level: dto.level,
        code: dto.code,
        fullCode,
        barcode: `LOC-${wh.code}-${fullCode}`,
        temperatureZone: dto.temperatureZone ?? 'AMBIENT',
        capacityUnits: dto.capacityUnits,
        pickSequence: dto.pickSequence ?? 0,
      },
    });
  }
}
