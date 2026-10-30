import { Injectable, Logger } from '@nestjs/common';
import { AuthContext, SYSTEM_ACTOR } from '../../common/auth-context';
import { DomainError, NotFound } from '../../common/errors';
import { PrismaService, Tx } from '../../common/prisma.service';
import { LedgerService } from './ledger.service';

export interface ReserveRequest {
  organizationId: string;
  warehouseId: string;
  items: { skuId: string; quantity: number }[];
  idempotencyKey: string;
  orderId?: string;
  ttlMinutes?: number;
}

/**
 * Reservation lifecycle: ACTIVE -> CONSUMED | RELEASED | EXPIRED.
 * Every terminal transition is a compare-and-set on status = 'ACTIVE', so a
 * reservation can be released or consumed at most once even under concurrent
 * cancel / expiry / pick requests.
 */
@Injectable()
export class ReservationService {
  private readonly logger = new Logger('Reservations');
  private readonly defaultTtl = Number(process.env.RESERVATION_TTL_MINUTES ?? 15);

  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService) {}

  async reserve(tx: Tx, actor: AuthContext, req: ReserveRequest) {
    const existing = await tx.inventoryReservation.findUnique({ where: { idempotencyKey: req.idempotencyKey }, include: { lines: true } });
    if (existing) return existing;

    const merged = new Map<string, number>();
    for (const i of req.items) {
      if (!Number.isInteger(i.quantity) || i.quantity <= 0) throw new DomainError('INVALID_QUANTITY', 'Quantities must be positive integers', 400);
      merged.set(i.skuId, (merged.get(i.skuId) ?? 0) + i.quantity);
    }

    const reservation = await tx.inventoryReservation.create({
      data: {
        organizationId: req.organizationId,
        warehouseId: req.warehouseId,
        orderId: req.orderId,
        idempotencyKey: req.idempotencyKey,
        expiresAt: new Date(Date.now() + (req.ttlMinutes ?? this.defaultTtl) * 60_000),
      },
    });

    // Process SKUs in a stable order so concurrent multi-SKU reservations lock rows consistently.
    for (const skuId of [...merged.keys()].sort()) {
      const lines = await this.ledger.allocateFefo(tx, req.warehouseId, skuId, merged.get(skuId)!);
      for (const line of lines) {
        const row = await tx.inventoryReservationLine.create({
          data: { reservationId: reservation.id, skuId, batchId: line.batchId, quantity: line.quantity },
        });
        await this.ledger.move(tx, {
          balanceId: line.balanceId, from: 'AVAILABLE', to: 'RESERVED', quantity: line.quantity, type: 'RESERVE',
          referenceType: 'reservation', referenceId: reservation.id, actor, idempotencyKey: `reserve:${row.id}`,
        });
      }
    }
    return tx.inventoryReservation.findUniqueOrThrow({ where: { id: reservation.id }, include: { lines: true } });
  }

  /** Returns true only for the single caller that actually released the stock. */
  async release(tx: Tx, actor: AuthContext, reservationId: string, reason: string, terminal: 'RELEASED' | 'EXPIRED' = 'RELEASED') {
    const claimed = await tx.inventoryReservation.updateMany({
      where: { id: reservationId, status: 'ACTIVE' },
      data: { status: terminal, releasedAt: new Date(), releaseReason: reason },
    });
    if (claimed.count === 0) return false;
    const lines = await tx.inventoryReservationLine.findMany({ where: { reservationId } });
    for (const l of lines) {
      const bal = await tx.inventoryBalance.findUniqueOrThrow({ where: { batchId: l.batchId } });
      await this.ledger.move(tx, {
        balanceId: bal.id, from: 'RESERVED', to: 'AVAILABLE', quantity: l.quantity, type: 'RELEASE',
        referenceType: 'reservation', referenceId: reservationId, actor, reason, idempotencyKey: `release:${l.id}`,
      });
    }
    return true;
  }

  /**
   * Consume on pick completion. `picked` maps reservation line id -> picked quantity.
   * Picked units leave the ledger (RESERVED -> NONE); any shortfall is released back.
   */
  async consume(tx: Tx, actor: AuthContext, reservationId: string, picked: Map<string, number>, referenceId: string) {
    const claimed = await tx.inventoryReservation.updateMany({
      where: { id: reservationId, status: 'ACTIVE' },
      data: { status: 'CONSUMED', consumedAt: new Date() },
    });
    if (claimed.count === 0) {
      const r = await tx.inventoryReservation.findUnique({ where: { id: reservationId } });
      if (!r) throw NotFound('Reservation', reservationId);
      throw new DomainError('RESERVATION_NOT_ACTIVE', `Reservation is ${r.status}; it cannot be consumed`, 409);
    }
    const lines = await tx.inventoryReservationLine.findMany({ where: { reservationId } });
    for (const l of lines) {
      const bal = await tx.inventoryBalance.findUniqueOrThrow({ where: { batchId: l.batchId } });
      const qty = Math.min(picked.get(l.id) ?? 0, l.quantity);
      if (qty > 0) {
        await this.ledger.move(tx, {
          balanceId: bal.id, from: 'RESERVED', to: 'NONE', quantity: qty, type: 'PICK',
          referenceType: 'picking_task', referenceId, actor, idempotencyKey: `pick:${l.id}`,
        });
      }
      if (l.quantity - qty > 0) {
        await this.ledger.move(tx, {
          balanceId: bal.id, from: 'RESERVED', to: 'AVAILABLE', quantity: l.quantity - qty, type: 'RELEASE',
          referenceType: 'picking_task', referenceId, actor, reason: 'short pick', idempotencyKey: `shortpick:${l.id}`,
        });
      }
    }
  }

  async extend(tx: Tx, reservationId: string, minutes: number) {
    await tx.inventoryReservation.updateMany({
      where: { id: reservationId, status: 'ACTIVE' },
      data: { expiresAt: new Date(Date.now() + minutes * 60_000) },
    });
  }

  /** Releases ACTIVE reservations past their TTL. Safe to run concurrently on many workers. */
  async expireDue(limit = 200) {
    const due = await this.prisma.inventoryReservation.findMany({
      where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
      select: { id: true, organizationId: true, orderId: true },
      take: limit,
    });
    let released = 0;
    for (const r of due) {
      const ok = await this.prisma.withRetry((tx) => this.release(tx, SYSTEM_ACTOR(r.organizationId), r.id, 'reservation TTL elapsed', 'EXPIRED'));
      if (ok) released++;
    }
    if (released) this.logger.log(`expired ${released} reservations`);
    return { scanned: due.length, released };
  }
}
