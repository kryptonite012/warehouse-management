import { Injectable } from '@nestjs/common';
import { InventoryBucket, MovementType, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthContext } from '../../common/auth-context';
import { DomainError } from '../../common/errors';
import { PrismaService, Tx } from '../../common/prisma.service';

const COLUMN: Record<InventoryBucket, string | null> = {
  NONE: null,
  AVAILABLE: 'available',
  RESERVED: 'reserved',
  DAMAGED: 'damaged',
  QUARANTINED: 'quarantined',
  EXPIRED: 'expired',
  IN_TRANSIT: 'in_transit',
};
const SELLABLE = new Set<InventoryBucket>(['AVAILABLE', 'RESERVED']);

export interface MoveInput {
  balanceId: string;
  from: InventoryBucket;
  to: InventoryBucket;
  quantity: number;
  type: MovementType;
  referenceType: string;
  referenceId: string;
  actor: AuthContext;
  idempotencyKey: string;
  reason?: string;
  sourceLocation?: string;
  destLocation?: string;
}

export interface MoveResult {
  applied: boolean; // false => idempotency key already applied earlier (no-op)
  movementId?: string;
}

export interface AllocationLine {
  skuId: string;
  batchId: string;
  balanceId: string;
  quantity: number;
  expiresAt: Date | null;
}

export class InsufficientStockError extends DomainError {
  constructor(details: unknown) {
    super('INSUFFICIENT_STOCK', 'Not enough sellable stock to fulfil the request', 409, details);
  }
}

/**
 * The only code path allowed to change inventory_balances.
 * Every change: (1) inserts an append-only movement keyed by an idempotency key,
 * (2) applies a single conditional UPDATE that cannot drive a bucket negative.
 * Both happen in the caller's transaction, so they commit or roll back together.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async move(tx: Tx, m: MoveInput): Promise<MoveResult> {
    if (!Number.isInteger(m.quantity) || m.quantity <= 0) {
      throw new DomainError('INVALID_QUANTITY', 'Movement quantity must be a positive integer', 400);
    }
    if (m.from === m.to) throw new DomainError('INVALID_MOVEMENT', 'Source and destination bucket are identical', 400);

    const bal = await tx.inventoryBalance.findUnique({ where: { id: m.balanceId } });
    if (!bal) throw new DomainError('NOT_FOUND', 'Inventory balance not found', 404);

    // 1) Claim the idempotency key. ON CONFLICT => already applied; do nothing.
    const movementId = randomUUID();
    const inserted = await tx.$executeRaw`
      INSERT INTO inventory_movements
        (id, organization_id, warehouse_id, sku_id, batch_id, movement_type, from_bucket, to_bucket,
         source_location, destination_location, quantity, reference_type, reference_id, actor_type, actor_id,
         reason, idempotency_key, created_at)
      VALUES
        (${movementId}::uuid, ${bal.organizationId}::uuid, ${bal.warehouseId}::uuid, ${bal.skuId}::uuid, ${bal.batchId}::uuid,
         ${m.type}::"MovementType", ${m.from}::"InventoryBucket", ${m.to}::"InventoryBucket",
         ${m.sourceLocation ?? null}, ${m.destLocation ?? null}, ${m.quantity}, ${m.referenceType}, ${m.referenceId},
         ${m.actor.kind.toUpperCase()}, ${m.actor.kind === 'system' ? null : m.actor.id}::uuid,
         ${m.reason ?? null}, ${m.idempotencyKey}, now())
      ON CONFLICT (idempotency_key) DO NOTHING`;
    if (inserted === 0) return { applied: false };

    // 2) Conditional balance update.
    const fromCol = COLUMN[m.from];
    const toCol = COLUMN[m.to];
    const onHandDelta = (SELLABLE.has(m.to) ? m.quantity : 0) - (SELLABLE.has(m.from) ? m.quantity : 0);
    const sets: string[] = ['version = version + 1', 'updated_at = now()'];
    if (fromCol) sets.push(`${fromCol} = ${fromCol} - $2`);
    if (toCol) sets.push(`${toCol} = ${toCol} + $2`);
    if (onHandDelta) sets.push(`on_hand = on_hand + (${onHandDelta > 0 ? '' : '-'}$2)`);
    const guard = fromCol ? ` AND ${fromCol} >= $2` : '';
    // Column names come only from the static COLUMN map above; values are bound parameters.
    const updated = await tx.$executeRawUnsafe(
      `UPDATE inventory_balances SET ${sets.join(', ')} WHERE id = $1::uuid${guard}`,
      m.balanceId,
      m.quantity,
    );
    if (updated === 0) {
      throw new InsufficientStockError({ balanceId: m.balanceId, bucket: m.from, requested: m.quantity });
    }
    return { applied: true, movementId };
  }

  /** Get-or-create the batch + balance row for an inbound movement. */
  async ensureBatch(
    tx: Tx,
    input: {
      organizationId: string; warehouseId: string; skuId: string; batchNumber: string;
      expiresAt?: Date | null; manufacturedAt?: Date | null; unitCost?: Prisma.Decimal | number; goodsReceiptItemId?: string;
    },
  ) {
    const batch = await tx.inventoryBatch.upsert({
      where: { warehouseId_skuId_batchNumber: { warehouseId: input.warehouseId, skuId: input.skuId, batchNumber: input.batchNumber } },
      create: {
        organizationId: input.organizationId, warehouseId: input.warehouseId, skuId: input.skuId, batchNumber: input.batchNumber,
        expiresAt: input.expiresAt ?? null, manufacturedAt: input.manufacturedAt ?? null, unitCost: input.unitCost ?? 0,
        goodsReceiptItemId: input.goodsReceiptItemId,
      },
      update: {},
    });
    const balance = await tx.inventoryBalance.upsert({
      where: { batchId: batch.id },
      create: { organizationId: input.organizationId, warehouseId: input.warehouseId, skuId: input.skuId, batchId: batch.id },
      update: {},
    });
    return { batch, balance };
  }

  /**
   * FEFO allocation: lock every sellable balance row for the SKU in a deterministic
   * order (by id, prevents deadlocks), then hand out quantity by earliest expiry.
   * Batches that are expired, or expire before `minExpiryDate`, are never eligible.
   */
  async allocateFefo(
    tx: Tx,
    warehouseId: string,
    skuId: string,
    quantity: number,
    opts: { minExpiryDate?: Date } = {},
  ): Promise<AllocationLine[]> {
    const minExpiry = opts.minExpiryDate ?? new Date();
    const rows = await tx.$queryRaw<{ id: string; batch_id: string; available: number; expires_at: Date | null; received_at: Date }[]>`
      SELECT b.id, b.batch_id, b.available, t.expires_at, t.received_at
      FROM inventory_balances b
      JOIN inventory_batches t ON t.id = b.batch_id
      WHERE b.warehouse_id = ${warehouseId}::uuid AND b.sku_id = ${skuId}::uuid
        AND b.available > 0 AND t.status = 'ACTIVE'
        AND (t.expires_at IS NULL OR t.expires_at > ${minExpiry}::date)
      ORDER BY b.id
      FOR UPDATE OF b`;
    rows.sort((a, b) => {
      const ea = a.expires_at?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const eb = b.expires_at?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return ea - eb || a.received_at.getTime() - b.received_at.getTime();
    });
    const lines: AllocationLine[] = [];
    let need = quantity;
    for (const r of rows) {
      if (need === 0) break;
      const take = Math.min(need, r.available);
      lines.push({ skuId, batchId: r.batch_id, balanceId: r.id, quantity: take, expiresAt: r.expires_at });
      need -= take;
    }
    if (need > 0) {
      const available = rows.reduce((s, r) => s + r.available, 0);
      throw new InsufficientStockError({ warehouseId, skuId, requested: quantity, available });
    }
    return lines;
  }

  /** Sellable availability per SKU at a site (excludes expired / inactive batches). */
  async availability(warehouseId: string, skuIds: string[]) {
    if (!skuIds.length) return new Map<string, number>();
    const rows = await this.prisma.$queryRaw<{ sku_id: string; available: bigint }[]>`
      SELECT b.sku_id, COALESCE(SUM(b.available), 0) AS available
      FROM inventory_balances b JOIN inventory_batches t ON t.id = b.batch_id
      WHERE b.warehouse_id = ${warehouseId}::uuid AND b.sku_id = ANY(${skuIds}::uuid[])
        AND t.status = 'ACTIVE' AND (t.expires_at IS NULL OR t.expires_at > CURRENT_DATE)
      GROUP BY b.sku_id`;
    const map = new Map<string, number>(skuIds.map((id) => [id, 0]));
    for (const r of rows) map.set(r.sku_id, Number(r.available));
    return map;
  }
}
