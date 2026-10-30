import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { LedgerService } from '../inventory/ledger.service';
import { ACTIVE_STATUSES } from './order-state';

export interface Destination {
  postalCode: string;
  latitude?: number | null;
  longitude?: number | null;
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Dark-store selection. Candidate = active store accepting orders whose service area
 * covers the destination (postal code list or radius around real store coordinates).
 * Ranking (configurable via setting `fulfillment.allocation`):
 *   1. can fulfil every line from sellable stock
 *   2. below its concurrent-order capacity
 *   3. lowest load ratio, then shortest distance.
 */
@Injectable()
export class StoreAllocationService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService) {}

  async serviceableStores(organizationId: string, dest: Destination) {
    const stores = await this.prisma.warehouse.findMany({
      where: { organizationId, type: 'DARK_STORE', status: 'ACTIVE', deletedAt: null, darkStore: { acceptingOrders: true } },
      include: { darkStore: true },
    });
    // A store that runs an edge agent but has not been heard from recently is treated as
    // disconnected: it cannot pick/pack/report reliably, so new orders are routed elsewhere.
    const offlineAfter = new Date(Date.now() - Number(process.env.EDGE_OFFLINE_MINUTES ?? 5) * 60_000);
    const devices = await this.prisma.edgeDevice.groupBy({
      by: ['warehouseId'],
      where: { warehouseId: { in: stores.map((s) => s.id) }, active: true },
      _max: { lastSeenAt: true },
    });
    const disconnected = new Set(devices.filter((d) => !d._max.lastSeenAt || d._max.lastSeenAt < offlineAfter).map((d) => d.warehouseId));
    return stores
      .filter((s) => !disconnected.has(s.id))
      .map((s) => {
        const distanceKm =
          dest.latitude != null && dest.longitude != null && s.latitude != null && s.longitude != null
            ? haversineKm({ lat: Number(s.latitude), lng: Number(s.longitude) }, { lat: Number(dest.latitude), lng: Number(dest.longitude) })
            : null;
        const byPostal = s.darkStore!.servicePostalCodes.includes(dest.postalCode);
        const byRadius = distanceKm !== null && distanceKm <= Number(s.darkStore!.serviceRadiusKm);
        return { store: s, distanceKm, serviceable: byPostal || byRadius };
      })
      .filter((c) => c.serviceable);
  }

  async select(organizationId: string, dest: Destination, items: { skuId: string; quantity: number }[]) {
    const candidates = await this.serviceableStores(organizationId, dest);
    if (!candidates.length) throw new DomainError('NOT_SERVICEABLE', 'No dark store currently delivers to this address', 422);

    const settings = await this.prisma.systemSetting.findFirst({ where: { organizationId, key: 'fulfillment.allocation' } });
    const rules = { preferDistance: false, ...((settings?.value as object) ?? {}) } as { preferDistance: boolean };

    const loads = await this.prisma.order.groupBy({
      by: ['darkStoreId'],
      where: { darkStoreId: { in: candidates.map((c) => c.store.id) }, status: { in: ACTIVE_STATUSES } },
      _count: true,
    });
    const ranked = [];
    for (const c of candidates) {
      const avail = await this.ledger.availability(c.store.id, items.map((i) => i.skuId));
      const shortages = items.filter((i) => (avail.get(i.skuId) ?? 0) < i.quantity).map((i) => ({ skuId: i.skuId, requested: i.quantity, available: avail.get(i.skuId) ?? 0 }));
      const active = loads.find((l) => l.darkStoreId === c.store.id)?._count ?? 0;
      const capacity = c.store.darkStore!.maxConcurrentOrders;
      ranked.push({ ...c, shortages, active, capacity, loadRatio: active / capacity });
    }
    ranked.sort((a, b) =>
      Number(a.shortages.length > 0) - Number(b.shortages.length > 0) ||
      Number(a.active >= a.capacity) - Number(b.active >= b.capacity) ||
      (rules.preferDistance
        ? (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || a.loadRatio - b.loadRatio
        : a.loadRatio - b.loadRatio || (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9)),
    );
    const best = ranked[0];
    if (best.active >= best.capacity) throw new DomainError('STORE_AT_CAPACITY', 'All nearby stores are at capacity; please try again shortly', 503);
    return { store: best.store, distanceKm: best.distanceKm, shortages: best.shortages, evaluated: ranked.length };
  }
}
