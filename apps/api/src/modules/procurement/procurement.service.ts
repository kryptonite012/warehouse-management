import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { assertWarehouseAccess, AuthContext, warehouseScopeFilter } from '../../common/auth-context';
import { nextDocNumber } from '../../common/doc-number';
import { Conflict, DomainError, Forbidden, NotFound } from '../../common/errors';
import { pageArgs, PageQuery, toPage } from '../../common/pagination';
import { PrismaService } from '../../common/prisma.service';
import { LedgerService } from '../inventory/ledger.service';
import {
  CreateGoodsReceiptDto, CreatePurchaseOrderDto, CreateSupplierDto, InspectDto, PoListQuery, SupplierPriceDto, UpdateSupplierDto,
} from './procurement.dto';

const round2 = (n: number) => Math.round(n * 100) / 100;
const PO_INCLUDE = { supplier: true, items: true, receipts: { include: { items: true } } } satisfies Prisma.PurchaseOrderInclude;

@Injectable()
export class ProcurementService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly audit: AuditService) {}

  // ---------------------------------------------------------------- suppliers

  async listSuppliers(actor: AuthContext, q: PageQuery) {
    const where: Prisma.SupplierWhereInput = {
      organizationId: actor.organizationId,
      OR: q.search ? [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }, { gstin: { contains: q.search } }] : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.supplier.findMany({ where, ...pageArgs(q, ['name', 'code', 'createdAt'], 'name') }),
      this.prisma.supplier.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  async getSupplier(actor: AuthContext, id: string) {
    const s = await this.prisma.supplier.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: { products: { orderBy: { validFrom: 'desc' } } },
    });
    if (!s) throw NotFound('Supplier', id);
    return { ...s, performance: await this.supplierPerformance(id) };
  }

  async createSupplier(actor: AuthContext, dto: CreateSupplierDto) {
    const s = await this.prisma.supplier.create({ data: { ...dto, organizationId: actor.organizationId } });
    await this.audit.record({ actor, action: 'supplier.create', resourceType: 'supplier', resourceId: s.id, after: dto });
    return s;
  }

  async updateSupplier(actor: AuthContext, id: string, dto: UpdateSupplierDto) {
    const before = await this.getSupplier(actor, id);
    const s = await this.prisma.supplier.update({ where: { id }, data: dto });
    await this.audit.record({ actor, action: 'supplier.update', resourceType: 'supplier', resourceId: id, before, after: dto });
    return s;
  }

  /** Price history is append-only: a new row per price change keeps historical prices. */
  async addSupplierPrice(actor: AuthContext, supplierId: string, dto: SupplierPriceDto) {
    await this.getSupplier(actor, supplierId);
    const row = await this.prisma.supplierProduct.create({ data: { supplierId, ...dto } });
    await this.audit.record({ actor, action: 'supplier.price', resourceType: 'supplier', resourceId: supplierId, after: dto });
    return row;
  }

  /** On-time and fill-rate metrics from completed receipts. */
  async supplierPerformance(supplierId: string) {
    const [row] = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(DISTINCT po.id)::int AS "purchaseOrders",
             COALESCE(SUM(i.ordered_qty), 0)::int AS "orderedUnits",
             COALESCE(SUM(i.accepted_qty), 0)::int AS "acceptedUnits",
             COALESCE(SUM(i.rejected_qty), 0)::int AS "rejectedUnits",
             CASE WHEN SUM(i.ordered_qty) > 0 THEN SUM(i.accepted_qty)::float / SUM(i.ordered_qty) END AS "fillRate",
             CASE WHEN SUM(i.received_qty) > 0 THEN SUM(i.rejected_qty)::float / SUM(i.received_qty) END AS "rejectionRate"
      FROM purchase_orders po JOIN purchase_order_items i ON i.purchase_order_id = po.id
      WHERE po.supplier_id = ${supplierId}::uuid AND po.status NOT IN ('DRAFT', 'CANCELLED', 'PENDING_APPROVAL')`;
    const [timing] = await this.prisma.$queryRaw<any[]>`
      SELECT COUNT(*)::int AS receipts,
             COUNT(*) FILTER (WHERE po.expected_at IS NOT NULL AND g.completed_at <= po.expected_at)::int AS "onTime",
             COUNT(*) FILTER (WHERE po.expected_at IS NOT NULL)::int AS "withExpectedDate"
      FROM goods_receipts g JOIN purchase_orders po ON po.id = g.purchase_order_id
      WHERE po.supplier_id = ${supplierId}::uuid AND g.status = 'COMPLETED'`;
    return {
      ...row,
      receipts: timing.receipts,
      onTimeRate: timing.withExpectedDate ? timing.onTime / timing.withExpectedDate : null,
    };
  }

  // ----------------------------------------------------------- purchase orders

  async listPurchaseOrders(actor: AuthContext, q: PoListQuery) {
    const where: Prisma.PurchaseOrderWhereInput = {
      organizationId: actor.organizationId,
      status: q.status as any,
      supplierId: q.supplierId,
      warehouseId: q.warehouseId,
      ...warehouseScopeFilter(actor),
      poNumber: q.search ? { contains: q.search, mode: 'insensitive' } : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where, include: { supplier: { select: { name: true, code: true } }, _count: { select: { items: true } } }, ...pageArgs(q, ['createdAt', 'total', 'poNumber'], 'createdAt') }),
      this.prisma.purchaseOrder.count({ where }),
    ]);
    return toPage(rows, total, q);
  }

  async getPurchaseOrder(actor: AuthContext, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({ where: { id, organizationId: actor.organizationId }, include: PO_INCLUDE });
    if (!po) throw NotFound('Purchase order', id);
    assertWarehouseAccess(actor, po.warehouseId);
    return {
      ...po,
      items: po.items.map((i) => ({ ...i, pendingQty: Math.max(i.orderedQty - i.receivedQty, 0) })),
    };
  }

  async createPurchaseOrder(actor: AuthContext, dto: CreatePurchaseOrderDto) {
    assertWarehouseAccess(actor, dto.warehouseId);
    const supplier = await this.prisma.supplier.findFirst({ where: { id: dto.supplierId, organizationId: actor.organizationId, status: 'ACTIVE' } });
    if (!supplier) throw NotFound('Active supplier', dto.supplierId);
    const skuIds = dto.items.map((i) => i.skuId);
    if (new Set(skuIds).size !== skuIds.length) throw new DomainError('DUPLICATE_LINES', 'Each SKU may appear once per purchase order', 400);
    const skus = await this.prisma.sku.findMany({ where: { id: { in: skuIds }, organizationId: actor.organizationId }, include: { product: { include: { taxCategory: true } } } });
    if (skus.length !== skuIds.length) throw NotFound('SKU');
    const prices = await this.prisma.supplierProduct.findMany({ where: { supplierId: supplier.id, skuId: { in: skuIds } }, orderBy: { validFrom: 'desc' } });

    let subtotal = 0;
    let taxTotal = 0;
    const items = dto.items.map((i) => {
      const sku = skus.find((s) => s.id === i.skuId)!;
      const unitCost = i.unitCost ?? Number(prices.find((p) => p.skuId === i.skuId)?.unitCost ?? sku.purchasePrice);
      const rate = Number(sku.product.taxCategory?.ratePercent ?? 0);
      const line = round2(unitCost * i.orderedQty);
      subtotal += line;
      taxTotal += round2((line * rate) / 100);
      return { skuId: i.skuId, orderedQty: i.orderedQty, unitCost, taxRatePercent: rate };
    });

    const po = await this.prisma.purchaseOrder.create({
      data: {
        organizationId: actor.organizationId, poNumber: await nextDocNumber(this.prisma, 'PO'), supplierId: supplier.id, warehouseId: dto.warehouseId,
        expectedAt: dto.expectedAt ? new Date(dto.expectedAt) : new Date(Date.now() + supplier.leadTimeDays * 86_400_000),
        notes: dto.notes, createdById: actor.id, subtotal: round2(subtotal), taxTotal: round2(taxTotal), total: round2(subtotal + taxTotal),
        items: { create: items },
      },
      include: PO_INCLUDE,
    });
    await this.audit.record({ actor, action: 'purchase_order.create', resourceType: 'purchase_order', resourceId: po.id, after: dto });
    return po;
  }

  async submitPurchaseOrder(actor: AuthContext, id: string) {
    await this.getPurchaseOrder(actor, id);
    return this.transition(actor, id, ['DRAFT'], 'PENDING_APPROVAL', 'purchase_order.submit');
  }

  /**
   * Approval with configurable limits. Setting `procurement.approval_limits` maps role code
   * to the maximum PO total that role can approve, e.g. {"PROCUREMENT_MANAGER": 200000}.
   * The approver must be a different user than the creator.
   */
  async approvePurchaseOrder(actor: AuthContext, id: string) {
    const po = await this.getPurchaseOrder(actor, id);
    if (po.createdById === actor.id && !actor.isSuperAdmin) throw Forbidden('The creator of a purchase order cannot approve it');
    const limit = await this.approvalLimit(actor);
    if (limit !== null && Number(po.total) > limit) {
      await this.audit.record({ actor, action: 'purchase_order.approve', resourceType: 'purchase_order', resourceId: id, outcome: 'DENIED', after: { total: po.total, limit } });
      throw Forbidden(`PO total ${po.total} exceeds your approval limit of ${limit}`);
    }
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.purchaseOrder.updateMany({
        where: { id, status: 'PENDING_APPROVAL', version: po.version },
        data: { status: 'APPROVED', approvedById: actor.id, approvedAt: new Date(), version: { increment: 1 } },
      });
      if (!count) throw Conflict('INVALID_PO_STATE', `Purchase order is ${po.status}; only PENDING_APPROVAL orders can be approved`);
      await this.audit.record({ actor, action: 'purchase_order.approve', resourceType: 'purchase_order', resourceId: id, after: { total: po.total } }, tx);
      return tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: PO_INCLUDE });
    });
  }

  async markSent(actor: AuthContext, id: string) {
    await this.getPurchaseOrder(actor, id);
    return this.transition(actor, id, ['APPROVED'], 'SENT', 'purchase_order.send');
  }

  async markConfirmed(actor: AuthContext, id: string) {
    await this.getPurchaseOrder(actor, id);
    return this.transition(actor, id, ['SENT'], 'CONFIRMED', 'purchase_order.confirm');
  }

  async cancelPurchaseOrder(actor: AuthContext, id: string) {
    const po = await this.getPurchaseOrder(actor, id);
    if (po.items.some((i) => i.receivedQty > 0)) throw Conflict('PO_HAS_RECEIPTS', 'Received purchase orders cannot be cancelled; close them instead');
    return this.transition(actor, id, ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'CONFIRMED'], 'CANCELLED', 'purchase_order.cancel');
  }

  async closePurchaseOrder(actor: AuthContext, id: string) {
    await this.getPurchaseOrder(actor, id);
    return this.transition(actor, id, ['PARTIALLY_RECEIVED', 'RECEIVED'], 'CLOSED', 'purchase_order.close');
  }

  // ------------------------------------------------------------ goods receipt

  /**
   * Records physical receipt. Units enter QUARANTINED (pending QC) — they are not
   * sellable until inspection accepts them. Over-receipt beyond the PO is rejected.
   */
  async createGoodsReceipt(actor: AuthContext, dto: CreateGoodsReceiptDto) {
    const po = await this.getPurchaseOrder(actor, dto.purchaseOrderId);
    if (!['APPROVED', 'SENT', 'CONFIRMED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
      throw Conflict('INVALID_PO_STATE', `Cannot receive against a ${po.status} purchase order`);
    }
    const existing = await this.prisma.inventoryMovement.findUnique({ where: { idempotencyKey: `grn:${dto.idempotencyKey}:0` } });
    if (existing) return this.getGoodsReceipt(actor, existing.referenceId);

    const products = await this.prisma.sku.findMany({ where: { id: { in: dto.items.map((i) => i.skuId) } }, include: { product: true } });
    const discrepancies: any[] = [];

    const grn = await this.prisma.withRetry(async (tx) => {
      const receipt = await tx.goodsReceipt.create({
        data: {
          organizationId: actor.organizationId, grnNumber: await nextDocNumber(tx, 'GRN'), purchaseOrderId: po.id,
          warehouseId: po.warehouseId, supplierInvoiceNo: dto.supplierInvoiceNo, receivedById: actor.id, status: 'INSPECTING',
        },
      });
      let idx = 0;
      for (const item of dto.items) {
        const line = po.items.find((i) => i.skuId === item.skuId);
        if (!line) throw new DomainError('SKU_NOT_ON_PO', `SKU ${item.skuId} is not on this purchase order`, 400);
        const product = products.find((p) => p.id === item.skuId)!.product;
        if (product.expiryTracked && !item.expiresAt) throw new DomainError('EXPIRY_REQUIRED', `${product.name} requires an expiry date`, 400);
        if (item.expiresAt && new Date(item.expiresAt) <= new Date()) throw new DomainError('ALREADY_EXPIRED', `${product.name} batch ${item.batchNumber} is already expired`, 400);

        // Atomic increment guarded by the outstanding quantity prevents concurrent over-receipt.
        const updated = await tx.$executeRaw`
          UPDATE purchase_order_items SET received_qty = received_qty + ${item.receivedQty}
          WHERE id = ${line.id}::uuid AND received_qty + ${item.receivedQty} <= ordered_qty`;
        if (!updated) {
          throw new DomainError('OVER_RECEIPT', `Receiving ${item.receivedQty} of ${product.name} exceeds the outstanding PO quantity`, 409, {
            ordered: line.orderedQty, alreadyReceived: line.receivedQty,
          });
        }
        const unitCost = item.unitCost ?? Number(line.unitCost);
        if (item.unitCost !== undefined && Math.abs(item.unitCost - Number(line.unitCost)) > 0.001) {
          discrepancies.push({ type: 'PRICE', skuId: item.skuId, poUnitCost: Number(line.unitCost), invoicedUnitCost: item.unitCost });
        }
        const gri = await tx.goodsReceiptItem.create({
          data: {
            goodsReceiptId: receipt.id, skuId: item.skuId, batchNumber: item.batchNumber, receivedQty: item.receivedQty, unitCost,
            manufacturedAt: item.manufacturedAt ? new Date(item.manufacturedAt) : null, expiresAt: item.expiresAt ? new Date(item.expiresAt) : null,
          },
        });
        const { balance } = await this.ledger.ensureBatch(tx, {
          organizationId: actor.organizationId, warehouseId: po.warehouseId, skuId: item.skuId, batchNumber: item.batchNumber,
          expiresAt: gri.expiresAt, manufacturedAt: gri.manufacturedAt, unitCost, goodsReceiptItemId: gri.id,
        });
        await this.ledger.move(tx, {
          balanceId: balance.id, from: 'NONE', to: 'QUARANTINED', quantity: item.receivedQty, type: 'RECEIPT',
          referenceType: 'goods_receipt', referenceId: receipt.id, actor, reason: 'received, pending QC',
          idempotencyKey: `grn:${dto.idempotencyKey}:${idx++}`,
        });
      }
      const items = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: po.id } });
      const fully = items.every((i) => i.receivedQty >= i.orderedQty);
      await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: fully ? 'RECEIVED' : 'PARTIALLY_RECEIVED', version: { increment: 1 } } });
      await this.audit.record({ actor, action: 'goods_receipt.create', resourceType: 'goods_receipt', resourceId: receipt.id, after: { ...dto, discrepancies } }, tx);
      return receipt;
    });
    return { ...(await this.getGoodsReceipt(actor, grn.id)), discrepancies };
  }

  async getGoodsReceipt(actor: AuthContext, id: string) {
    const g = await this.prisma.goodsReceipt.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: { items: true, purchaseOrder: { include: { supplier: true, items: true } } },
    });
    if (!g) throw NotFound('Goods receipt', id);
    assertWarehouseAccess(actor, g.warehouseId);
    return g;
  }

  listGoodsReceipts(actor: AuthContext, status?: string) {
    return this.prisma.goodsReceipt.findMany({
      where: { organizationId: actor.organizationId, status: status as any, ...warehouseScopeFilter(actor) },
      include: { purchaseOrder: { select: { poNumber: true, supplier: { select: { name: true } } } }, _count: { select: { items: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** QC: accepted -> AVAILABLE, damaged -> DAMAGED, rejected -> leaves stock (returned to supplier). */
  async inspect(actor: AuthContext, id: string, dto: InspectDto) {
    const g = await this.getGoodsReceipt(actor, id);
    if (g.status !== 'INSPECTING') throw Conflict('INVALID_GRN_STATE', `Goods receipt is ${g.status}`);
    return this.prisma.withRetry(async (tx) => {
      for (const l of dto.lines) {
        const item = g.items.find((i) => i.id === l.itemId);
        if (!item) throw NotFound('Receipt line', l.itemId);
        if (item.inspectedAt) throw Conflict('ALREADY_INSPECTED', `Line ${l.itemId} was already inspected`);
        if (l.acceptedQty + l.rejectedQty + l.damagedQty !== item.receivedQty) {
          throw new DomainError('QTY_MISMATCH', `accepted + rejected + damaged must equal received (${item.receivedQty})`, 400);
        }
        if (l.rejectedQty > 0 && !l.rejectionReason) throw new DomainError('REASON_REQUIRED', 'A rejection reason is required', 400);
        const batch = await tx.inventoryBatch.findUniqueOrThrow({
          where: { warehouseId_skuId_batchNumber: { warehouseId: g.warehouseId, skuId: item.skuId, batchNumber: item.batchNumber } },
          include: { balance: true },
        });
        const bal = batch.balance!;
        const moves: [number, any, any, string][] = [
          [l.acceptedQty, 'AVAILABLE', 'PUTAWAY', 'accepted'],
          [l.damagedQty, 'DAMAGED', 'DAMAGE', 'damaged'],
          [l.rejectedQty, 'NONE', 'ADJUSTMENT_OUT', 'rejected'],
        ];
        for (const [qty, to, type, tag] of moves) {
          if (qty <= 0) continue;
          await this.ledger.move(tx, {
            balanceId: bal.id, from: 'QUARANTINED', to, quantity: qty, type,
            referenceType: 'goods_receipt', referenceId: g.id, actor,
            reason: tag === 'rejected' ? `QC rejected: ${l.rejectionReason}` : `QC ${tag}`,
            idempotencyKey: `qc:${item.id}:${tag}`,
          });
        }
        await tx.goodsReceiptItem.update({
          where: { id: item.id },
          data: { acceptedQty: l.acceptedQty, rejectedQty: l.rejectedQty, damagedQty: l.damagedQty, rejectionReason: l.rejectionReason, inspectedById: actor.id, inspectedAt: new Date() },
        });
        await tx.$executeRaw`
          UPDATE purchase_order_items SET accepted_qty = accepted_qty + ${l.acceptedQty}, rejected_qty = rejected_qty + ${l.rejectedQty + l.damagedQty}
          WHERE purchase_order_id = ${g.purchaseOrderId}::uuid AND sku_id = ${item.skuId}::uuid`;
      }
      await this.audit.record({ actor, action: 'goods_receipt.inspect', resourceType: 'goods_receipt', resourceId: id, after: dto }, tx);
      return tx.goodsReceipt.findUniqueOrThrow({ where: { id }, include: { items: true } });
    });
  }

  async complete(actor: AuthContext, id: string) {
    const g = await this.getGoodsReceipt(actor, id);
    if (g.items.some((i) => !i.inspectedAt)) throw Conflict('INSPECTION_PENDING', 'All lines must be inspected before completing the receipt');
    const { count } = await this.prisma.goodsReceipt.updateMany({ where: { id, status: 'INSPECTING' }, data: { status: 'COMPLETED', completedAt: new Date() } });
    if (!count) throw Conflict('INVALID_GRN_STATE', `Goods receipt is ${g.status}`);
    await this.audit.record({ actor, action: 'goods_receipt.complete', resourceType: 'goods_receipt', resourceId: id });
    return this.getGoodsReceipt(actor, id);
  }

  // ------------------------------------------------------------- documents

  async purchaseOrderHtml(actor: AuthContext, id: string) {
    const po = await this.getPurchaseOrder(actor, id);
    const [wh, skus] = await Promise.all([
      this.prisma.warehouse.findUniqueOrThrow({ where: { id: po.warehouseId } }),
      this.prisma.sku.findMany({ where: { id: { in: po.items.map((i) => i.skuId) } }, include: { product: true } }),
    ]);
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const rows = po.items.map((i) => {
      const s = skus.find((k) => k.id === i.skuId)!;
      return `<tr><td>${esc(s.code)}</td><td>${esc(s.product.name)}</td><td class=n>${i.orderedQty}</td><td class=n>${i.receivedQty}</td><td class=n>${esc(i.unitCost)}</td><td class=n>${esc(i.taxRatePercent)}%</td><td class=n>${(Number(i.unitCost) * i.orderedQty).toFixed(2)}</td></tr>`;
    }).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(po.poNumber)}</title>
<style>body{font:13px system-ui,sans-serif;margin:32px;color:#111}h1{font-size:20px}table{width:100%;border-collapse:collapse;margin-top:16px}
td,th{border:1px solid #ccc;padding:6px;text-align:left}.n{text-align:right}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media print{button{display:none}}</style></head>
<body><button onclick="print()">Print / Save as PDF</button><h1>Purchase Order ${esc(po.poNumber)}</h1>
<div class=grid><div><b>Supplier</b><br>${esc(po.supplier.name)}<br>GSTIN: ${esc(po.supplier.gstin ?? '-')}<br>${esc(po.supplier.address ?? '')}</div>
<div><b>Deliver to</b><br>${esc(wh.name)} (${esc(wh.code)})<br>${esc(wh.addressLine1)}, ${esc(wh.city)} ${esc(wh.postalCode)}<br>Expected: ${po.expectedAt?.toISOString().slice(0, 10) ?? '-'}</div></div>
<p>Status: <b>${po.status}</b> · Created ${po.createdAt.toISOString().slice(0, 10)} · Payment terms ${po.supplier.paymentTermsDays} days</p>
<table><thead><tr><th>SKU</th><th>Product</th><th class=n>Ordered</th><th class=n>Received</th><th class=n>Unit cost</th><th class=n>Tax</th><th class=n>Line total</th></tr></thead><tbody>${rows}</tbody></table>
<p class=n>Subtotal ${po.subtotal} · Tax ${po.taxTotal} · <b>Total ${po.total}</b></p></body></html>`;
  }

  // ---------------------------------------------------------------- helpers

  private async transition(actor: AuthContext, id: string, from: string[], to: string, action: string) {
    const { count } = await this.prisma.purchaseOrder.updateMany({
      where: { id, organizationId: actor.organizationId, status: { in: from as any } },
      data: { status: to as any, version: { increment: 1 } },
    });
    if (!count) throw Conflict('INVALID_PO_STATE', `Purchase order must be in ${from.join(' / ')} to move to ${to}`);
    await this.audit.record({ actor, action, resourceType: 'purchase_order', resourceId: id, after: { status: to } });
    return this.getPurchaseOrder(actor, id);
  }

  private async approvalLimit(actor: AuthContext): Promise<number | null> {
    if (actor.isSuperAdmin) return null;
    const setting = await this.prisma.systemSetting.findFirst({ where: { organizationId: actor.organizationId, key: 'procurement.approval_limits' } });
    if (!setting) return null;
    const limits = setting.value as Record<string, number>;
    const roles = await this.prisma.userRole.findMany({ where: { userId: actor.id }, include: { role: true } });
    const applicable = roles.map((r) => limits[r.role.code]).filter((v): v is number => typeof v === 'number');
    return applicable.length ? Math.max(...applicable) : 0;
  }
}
