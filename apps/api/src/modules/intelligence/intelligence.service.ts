import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit.service';
import { assertWarehouseAccess, AuthContext, warehouseScopeFilter } from '../../common/auth-context';
import { Conflict, DomainError, NotFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { InventoryService } from '../inventory/inventory.service';

interface SkuSeries {
  skuId: string;
  daily: number[]; // oldest -> newest, one value per day
}

export interface ForecastResult {
  skuId: string;
  predictedUnits: number;
  lowerBound: number;
  upperBound: number;
  confidence: number | null;
  method: string;
  modelVersion: string;
  features: Record<string, unknown>;
}

const HISTORY_DAYS = 56;

/**
 * Bridges operational data and the optional Python AI engine.
 * If the engine is unreachable, results come from an explicitly labelled
 * rule (moving average) — never presented as a model prediction.
 */
@Injectable()
export class IntelligenceService {
  private readonly logger = new Logger('Intelligence');
  private readonly engineUrl = process.env.AI_ENGINE_URL;

  constructor(private readonly prisma: PrismaService, private readonly inventory: InventoryService, private readonly audit: AuditService) {}

  async engineStatus() {
    if (!this.engineUrl) return { status: 'NOT_CONFIGURED', fallback: 'rule-based' };
    try {
      const res = await fetch(`${this.engineUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return { status: res.ok ? 'AVAILABLE' : 'UNHEALTHY', ...(res.ok ? ((await res.json()) as object) : {}) };
    } catch {
      return { status: 'UNAVAILABLE', fallback: 'rule-based' };
    }
  }

  /** Daily units sold per SKU at a site over the last HISTORY_DAYS (from delivered/in-flight orders). */
  async salesHistory(warehouseId: string): Promise<{ series: SkuSeries[]; from: Date; to: Date }> {
    const to = new Date();
    to.setUTCHours(0, 0, 0, 0);
    const from = new Date(to.getTime() - HISTORY_DAYS * 86_400_000);
    const rows = await this.prisma.$queryRaw<{ sku_id: string; day: Date; units: number }[]>`
      SELECT i.sku_id, date_trunc('day', o.placed_at) AS day, SUM(i.quantity)::int AS units
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.dark_store_id = ${warehouseId}::uuid AND o.placed_at >= ${from} AND o.placed_at < ${to}
        AND o.status NOT IN ('CANCELLED', 'PAYMENT_FAILED', 'PAYMENT_PENDING')
      GROUP BY 1, 2`;
    const stocked = await this.prisma.inventoryBalance.findMany({ where: { warehouseId }, select: { skuId: true }, distinct: ['skuId'] });
    const ids = new Set([...stocked.map((s) => s.skuId), ...rows.map((r) => r.sku_id)]);
    const series = [...ids].map((skuId) => {
      const daily = Array(HISTORY_DAYS).fill(0);
      for (const r of rows.filter((x) => x.sku_id === skuId)) {
        const idx = Math.floor((r.day.getTime() - from.getTime()) / 86_400_000);
        if (idx >= 0 && idx < HISTORY_DAYS) daily[idx] += r.units;
      }
      return { skuId, daily };
    });
    return { series, from, to };
  }

  async runForecast(actor: AuthContext, warehouseId: string, horizonDays: number) {
    assertWarehouseAccess(actor, warehouseId);
    const { series, from, to } = await this.salesHistory(warehouseId);
    if (!series.length) throw new DomainError('NO_DATA', 'No stocked or sold SKUs at this site', 422);
    let results: ForecastResult[] | null = null;
    if (this.engineUrl) {
      try {
        const res = await fetch(`${this.engineUrl}/forecast`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ horizon_days: horizonDays, series: series.map((s) => ({ sku_id: s.skuId, daily_units: s.daily })) }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          const body = (await res.json()) as any;
          results = body.forecasts.map((f: any) => ({
            skuId: f.sku_id, predictedUnits: f.predicted_units, lowerBound: f.lower_bound, upperBound: f.upper_bound,
            confidence: f.confidence, method: f.method, modelVersion: body.model_version, features: f.supporting_variables ?? {},
          }));
        } else this.logger.warn(`AI engine returned ${res.status}; using rule fallback`);
      } catch (e) {
        this.logger.warn(`AI engine unreachable (${(e as Error).message}); using rule fallback`);
      }
    }
    results ??= series.map((s) => IntelligenceService.movingAverage(s, horizonDays));

    await this.prisma.demandForecast.createMany({
      data: results.map((r) => ({
        organizationId: actor.organizationId, warehouseId, skuId: r.skuId, horizonDays,
        predictedUnits: r.predictedUnits, lowerBound: r.lowerBound, upperBound: r.upperBound, confidence: r.confidence ?? 0,
        method: r.method, modelVersion: r.modelVersion, dataFrom: from, dataTo: to, features: r.features as any,
      })),
    });
    await this.audit.record({ actor, action: 'intelligence.forecast_run', resourceType: 'warehouse', resourceId: warehouseId, after: { skus: results.length, method: results[0]?.method } });
    return { warehouseId, horizonDays, dataPeriod: { from, to }, count: results.length, method: results[0]?.method };
  }

  /** Rule fallback. Labelled `rule:` and carries no model confidence. */
  static movingAverage(s: SkuSeries, horizonDays: number): ForecastResult {
    const last28 = s.daily.slice(-28);
    const mean = last28.reduce((a, b) => a + b, 0) / last28.length;
    const sd = Math.sqrt(last28.reduce((a, b) => a + (b - mean) ** 2, 0) / last28.length);
    const total = mean * horizonDays;
    return {
      skuId: s.skuId,
      predictedUnits: Math.round(total * 100) / 100,
      lowerBound: Math.max(0, Math.round((total - 1.28 * sd * Math.sqrt(horizonDays)) * 100) / 100),
      upperBound: Math.round((total + 1.28 * sd * Math.sqrt(horizonDays)) * 100) / 100,
      confidence: null,
      method: 'rule:moving_average_28d',
      modelVersion: 'rule-v1',
      features: { meanDailyUnits: mean, stdDailyUnits: sd, windowDays: 28 },
    };
  }

  async latestForecasts(actor: AuthContext, warehouseId: string) {
    assertWarehouseAccess(actor, warehouseId);
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT DISTINCT ON (f.sku_id) f.*, k.code AS sku_code, p.name AS product_name
      FROM demand_forecasts f JOIN skus k ON k.id = f.sku_id JOIN products p ON p.id = k.product_id
      WHERE f.warehouse_id = ${warehouseId}::uuid ORDER BY f.sku_id, f.created_at DESC`;
    return rows.map((r) => ({
      skuId: r.sku_id, skuCode: r.sku_code, productName: r.product_name,
      predictedOutcome: { unitsNextDays: Number(r.predicted_units), horizonDays: r.horizon_days, range: [Number(r.lower_bound), Number(r.upper_bound)] },
      confidence: String(r.method).startsWith('rule:') ? null : Number(r.confidence),
      isModelPrediction: !String(r.method).startsWith('rule:'),
      dataPeriod: { from: r.data_from, to: r.data_to },
      supportingVariables: r.features,
      method: r.method, modelVersion: r.model_version, lastUpdate: r.created_at,
    }));
  }

  /**
   * Replenishment for a dark store from its supplying warehouse.
   * Basis RULE_REORDER_POINT when no forecast exists; FORECAST when a recent one does.
   */
  async runReplenishment(actor: AuthContext, warehouseId: string) {
    assertWarehouseAccess(actor, warehouseId);
    const store = await this.prisma.warehouse.findFirst({ where: { id: warehouseId, organizationId: actor.organizationId }, include: { darkStore: true } });
    if (!store) throw NotFound('Warehouse', warehouseId);
    const source = store.darkStore?.supplyingWarehouseId ?? null;
    const stock = await this.prisma.$queryRaw<{ sku_id: string; available: number; in_transit: number; reorder_point: number; reorder_qty: number }[]>`
      SELECT b.sku_id, SUM(b.available)::int AS available, SUM(b.in_transit)::int AS in_transit, k.reorder_point, k.reorder_qty
      FROM inventory_balances b JOIN skus k ON k.id = b.sku_id
      WHERE b.warehouse_id = ${warehouseId}::uuid AND k.status = 'ACTIVE'
      GROUP BY b.sku_id, k.reorder_point, k.reorder_qty`;
    const forecasts = new Map((await this.latestForecasts(actor, warehouseId).catch(() => [])).map((f) => [f.skuId, f]));
    await this.prisma.replenishmentRecommendation.updateMany({ where: { warehouseId, status: 'OPEN' }, data: { status: 'SUPERSEDED' } });

    const recs = [];
    for (const s of stock) {
      const position = s.available + s.in_transit;
      const f = forecasts.get(s.sku_id);
      const fresh = f && Date.now() - new Date(f.lastUpdate).getTime() < 3 * 86_400_000;
      // Reorder-point rule is the safety floor; a fresh forecast can raise the quantity, never lower it.
      const ruleQty = position <= s.reorder_point ? Math.max(s.reorder_qty, s.reorder_point - position) : 0;
      const demand = fresh ? f!.predictedOutcome.range[1] : 0; // cover the upper forecast bound over the horizon
      const forecastQty = fresh ? Math.max(0, Math.ceil(demand - position)) : 0;
      const qty = Math.max(ruleQty, forecastQty);
      const basis = forecastQty > ruleQty ? 'FORECAST' : 'RULE_REORDER_POINT';
      const explanation: Record<string, unknown> = {
        position, reorderPoint: s.reorder_point, reorderQty: s.reorder_qty, ruleQty,
        ...(fresh ? { forecastUpper: demand, horizonDays: f!.predictedOutcome.horizonDays, forecastMethod: f!.method, forecastQty } : { forecast: 'none recent' }),
      };
      if (qty > 0) {
        recs.push(
          await this.prisma.replenishmentRecommendation.create({
            data: {
              organizationId: actor.organizationId, warehouseId, sourceWarehouseId: source, skuId: s.sku_id,
              currentAvailable: s.available, recommendedQty: qty, basis, explanation: explanation as any,
            },
          }),
        );
      }
    }
    return { warehouseId, sourceWarehouseId: source, recommendations: recs.length };
  }

  listRecommendations(actor: AuthContext, warehouseId?: string) {
    if (warehouseId) assertWarehouseAccess(actor, warehouseId);
    return this.prisma.replenishmentRecommendation.findMany({
      where: { organizationId: actor.organizationId, warehouseId, status: 'OPEN', ...warehouseScopeFilter(actor) },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  /** Turns accepted recommendations into a draft stock transfer from the supplying warehouse. */
  async acceptRecommendations(actor: AuthContext, ids: string[]) {
    const recs = await this.prisma.replenishmentRecommendation.findMany({ where: { id: { in: ids }, organizationId: actor.organizationId, status: 'OPEN' } });
    if (recs.length !== ids.length) throw Conflict('NOT_OPEN', 'Some recommendations are no longer open');
    const sites = new Set(recs.map((r) => `${r.sourceWarehouseId}->${r.warehouseId}`));
    if (sites.size !== 1) throw new DomainError('MIXED_SITES', 'Accept recommendations for one store at a time', 400);
    const r0 = recs[0];
    if (!r0.sourceWarehouseId) throw new DomainError('NO_SOURCE', 'Store has no supplying warehouse configured', 422);
    const transfer = await this.inventory.createTransfer(actor, {
      fromWarehouseId: r0.sourceWarehouseId, toWarehouseId: r0.warehouseId, reason: 'replenishment',
      items: recs.map((r) => ({ skuId: r.skuId, quantity: r.recommendedQty })),
    });
    await this.prisma.replenishmentRecommendation.updateMany({ where: { id: { in: ids } }, data: { status: 'ACCEPTED', transferId: transfer.id } });
    return transfer;
  }

  /**
   * Unusual movement detection. Uses the engine's IsolationForest when available,
   * otherwise a labelled z-score rule over per-SKU daily adjustment/write-off volume.
   */
  async anomalies(actor: AuthContext, warehouseId: string) {
    assertWarehouseAccess(actor, warehouseId);
    const rows = await this.prisma.$queryRaw<{ sku_id: string; day: Date; movement_type: string; units: number }[]>`
      SELECT sku_id, date_trunc('day', created_at) AS day, movement_type, SUM(quantity)::int AS units
      FROM inventory_movements
      WHERE warehouse_id = ${warehouseId}::uuid AND created_at >= now() - interval '30 days'
        AND movement_type IN ('ADJUSTMENT_OUT', 'WRITE_OFF', 'DAMAGE', 'COUNT_CORRECTION', 'ADJUSTMENT_IN')
      GROUP BY 1, 2, 3`;
    if (this.engineUrl) {
      try {
        const res = await fetch(`${this.engineUrl}/anomalies`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ records: rows.map((r) => ({ sku_id: r.sku_id, day: r.day.toISOString().slice(0, 10), movement_type: r.movement_type, units: r.units })) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return res.json();
      } catch {
        /* fall through to rule */
      }
    }
    const units = rows.map((r) => r.units);
    const mean = units.reduce((a, b) => a + b, 0) / (units.length || 1);
    const sd = Math.sqrt(units.reduce((a, b) => a + (b - mean) ** 2, 0) / (units.length || 1)) || 1;
    return {
      method: 'rule:zscore>3',
      model_version: 'rule-v1',
      anomalies: rows
        .map((r) => ({ sku_id: r.sku_id, day: r.day, movement_type: r.movement_type, units: r.units, score: (r.units - mean) / sd }))
        .filter((r) => r.score > 3),
    };
  }
}
