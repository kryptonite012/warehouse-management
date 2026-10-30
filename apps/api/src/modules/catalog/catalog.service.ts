import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit.service';
import { AuthContext, hasPermission } from '../../common/auth-context';
import { isValidEan13 } from '../../common/barcode';
import { Conflict, DomainError, Forbidden, NotFound } from '../../common/errors';
import { pageArgs, toPage } from '../../common/pagination';
import { PERMISSIONS } from '../../common/permissions';
import { PrismaService, Tx } from '../../common/prisma.service';
import { AddBarcodeDto, CreateCategoryDto, CreateProductDto, ProductListQuery, SkuInputDto, UpdateProductDto, UpdateSkuPriceDto } from './catalog.dto';
import { parseCsv, toCsv } from './csv';

const PRODUCT_INCLUDE = {
  brand: true,
  category: { select: { id: true, name: true } },
  subcategory: { select: { id: true, name: true } },
  taxCategory: true,
  images: { orderBy: { sortOrder: 'asc' } },
  skus: { include: { barcodes: true }, orderBy: { code: 'asc' } },
} satisfies Prisma.ProductInclude;

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export const CSV_COLUMNS = [
  'product_name', 'brand', 'category', 'subcategory', 'description', 'storage_condition', 'shelf_life_days',
  'sku_code', 'variant_name', 'unit', 'net_quantity', 'weight_grams', 'mrp', 'selling_price', 'purchase_price',
  'reorder_point', 'reorder_qty', 'barcodes', 'tax_code', 'status',
];

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(actor: AuthContext, q: ProductListQuery) {
    const where: Prisma.ProductWhereInput = {
      organizationId: actor.organizationId,
      deletedAt: null,
      status: q.status as any,
      storageCondition: q.storageCondition as any,
      OR: q.categoryId ? [{ categoryId: q.categoryId }, { subcategoryId: q.categoryId }] : undefined,
      AND: [
        q.search
          ? { OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { skus: { some: { code: { contains: q.search, mode: 'insensitive' } } } }] }
          : {},
        q.barcode ? { skus: { some: { barcodes: { some: { barcode: q.barcode } } } } } : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({ where, include: PRODUCT_INCLUDE, ...pageArgs(q, ['name', 'createdAt', 'updatedAt'], 'name') }),
      this.prisma.product.count({ where }),
    ]);
    return toPage(rows.map((p) => this.redact(actor, p)), total, q);
  }

  async get(actor: AuthContext, id: string) {
    const p = await this.prisma.product.findFirst({ where: { id, organizationId: actor.organizationId, deletedAt: null }, include: PRODUCT_INCLUDE });
    if (!p) throw NotFound('Product', id);
    return this.redact(actor, p);
  }

  async create(actor: AuthContext, dto: CreateProductDto) {
    this.assertPricing(dto.skus);
    await this.assertNoDuplicateSkus(actor.organizationId, dto.skus);
    return this.prisma.$transaction(async (tx) => {
      const product = await this.insertProduct(tx, actor, dto);
      await this.audit.record({ actor, action: 'product.create', resourceType: 'product', resourceId: product.id, after: dto }, tx);
      return product;
    });
  }

  async update(actor: AuthContext, id: string, dto: UpdateProductDto) {
    const before = await this.get(actor, id);
    const { version, ...data } = dto;
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.product.updateMany({ where: { id, version }, data: { ...data, version: { increment: 1 } } });
      if (!count) throw Conflict('STALE_VERSION', 'Product was modified by someone else. Reload and retry.', { currentVersion: before.version });
      if (dto.status === 'INACTIVE' || dto.status === 'DISCONTINUED') {
        await tx.sku.updateMany({ where: { productId: id }, data: { status: dto.status } });
      }
      await this.audit.record({ actor, action: 'product.update', resourceType: 'product', resourceId: id, before, after: dto }, tx);
      return tx.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_INCLUDE });
    });
  }

  /** Price changes require prices.manage and are always audited with before/after. */
  async updateSkuPricing(actor: AuthContext, skuId: string, dto: UpdateSkuPriceDto) {
    const priceFields = dto.mrp !== undefined || dto.sellingPrice !== undefined || dto.purchasePrice !== undefined;
    if (priceFields && !hasPermission(actor, PERMISSIONS.PRICES_MANAGE)) throw Forbidden('Changing prices requires prices.manage');
    const sku = await this.prisma.sku.findFirst({ where: { id: skuId, organizationId: actor.organizationId } });
    if (!sku) throw NotFound('SKU', skuId);
    const merged = {
      mrp: dto.mrp ?? Number(sku.mrp),
      sellingPrice: dto.sellingPrice ?? Number(sku.sellingPrice),
      purchasePrice: dto.purchasePrice ?? Number(sku.purchasePrice),
    };
    this.assertPricing([merged as any]);
    const { version, ...data } = dto;
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.sku.updateMany({ where: { id: skuId, version }, data: { ...data, version: { increment: 1 } } });
      if (!count) throw Conflict('STALE_VERSION', 'SKU was modified by someone else. Reload and retry.', { currentVersion: sku.version });
      await this.audit.record({
        actor, action: 'sku.pricing_update', resourceType: 'sku', resourceId: skuId,
        before: { mrp: sku.mrp, sellingPrice: sku.sellingPrice, purchasePrice: sku.purchasePrice, reorderPoint: sku.reorderPoint },
        after: dto,
      }, tx);
      return tx.sku.findUniqueOrThrow({ where: { id: skuId }, include: { barcodes: true } });
    });
  }

  async barcodes(actor: AuthContext, productId: string) {
    const p = await this.get(actor, productId);
    return p.skus.flatMap((s: any) => s.barcodes.map((b: any) => ({ ...b, skuCode: s.code })));
  }

  async addBarcode(actor: AuthContext, skuId: string, dto: AddBarcodeDto) {
    const sku = await this.prisma.sku.findFirst({ where: { id: skuId, organizationId: actor.organizationId } });
    if (!sku) throw NotFound('SKU', skuId);
    const symbology = isValidEan13(dto.barcode) ? 'EAN13' : 'CODE128';
    const b = await this.prisma.productBarcode.create({
      data: { organizationId: actor.organizationId, skuId, barcode: dto.barcode, symbology, isPrimary: dto.isPrimary ?? false },
    });
    await this.audit.record({ actor, action: 'barcode.add', resourceType: 'sku', resourceId: skuId, after: dto });
    return b;
  }

  async resolveBarcode(actor: AuthContext, barcode: string) {
    const b = await this.prisma.productBarcode.findUnique({
      where: { organizationId_barcode: { organizationId: actor.organizationId, barcode } },
      include: { sku: { include: { product: { select: { id: true, name: true, storageCondition: true } } } } },
    });
    if (!b) throw NotFound('Barcode', barcode);
    return b;
  }

  // -------------------------------------------------------------- categories

  categories(actor: AuthContext) {
    return this.prisma.productCategory.findMany({
      where: { organizationId: actor.organizationId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
  }

  async createCategory(actor: AuthContext, dto: CreateCategoryDto) {
    if (dto.parentId) {
      const parent = await this.prisma.productCategory.findFirst({ where: { id: dto.parentId, organizationId: actor.organizationId } });
      if (!parent) throw NotFound('Category', dto.parentId);
      if (parent.parentId) throw new DomainError('INVALID_HIERARCHY', 'Categories support two levels (category > subcategory)', 400);
    }
    return this.prisma.productCategory.create({
      data: { organizationId: actor.organizationId, name: dto.name, parentId: dto.parentId, slug: slugify(dto.name), sortOrder: dto.sortOrder ?? 0 },
    });
  }

  taxCategories(actor: AuthContext) {
    return this.prisma.taxCategory.findMany({ where: { organizationId: actor.organizationId }, orderBy: { code: 'asc' } });
  }

  // --------------------------------------------------------------- import / export

  /**
   * Bulk CSV import. Rows are grouped by product_name; each row is one SKU.
   * Validation runs over the whole file first; nothing is written if any row is invalid.
   */
  async importCsv(actor: AuthContext, csv: string, dryRun: boolean) {
    const rows = parseCsv(csv);
    if (!rows.length) throw new DomainError('EMPTY_FILE', 'CSV contains no data rows', 400);
    if (rows.length > 5000) throw new DomainError('FILE_TOO_LARGE', 'Import at most 5000 rows per file', 400);
    const missingCols = ['product_name', 'category', 'sku_code', 'mrp', 'selling_price', 'purchase_price'].filter((c) => !(c in rows[0]));
    if (missingCols.length) throw new DomainError('MISSING_COLUMNS', `Missing columns: ${missingCols.join(', ')}`, 400);

    const errors: { row: number; message: string }[] = [];
    const seenSku = new Set<string>();
    const seenBarcode = new Set<string>();
    rows.forEach((r, i) => {
      const line = i + 2;
      if (!r.product_name) errors.push({ row: line, message: 'product_name is required' });
      if (!/^[A-Z0-9-]{3,40}$/.test(r.sku_code)) errors.push({ row: line, message: `invalid sku_code "${r.sku_code}"` });
      if (seenSku.has(r.sku_code)) errors.push({ row: line, message: `duplicate sku_code ${r.sku_code} in file` });
      seenSku.add(r.sku_code);
      for (const f of ['mrp', 'selling_price', 'purchase_price']) {
        if (!/^\d+(\.\d{1,2})?$/.test(r[f])) errors.push({ row: line, message: `${f} must be a decimal amount` });
      }
      if (Number(r.selling_price) > Number(r.mrp)) errors.push({ row: line, message: 'selling_price cannot exceed MRP' });
      for (const b of (r.barcodes ?? '').split('|').filter(Boolean)) {
        if (seenBarcode.has(b)) errors.push({ row: line, message: `duplicate barcode ${b} in file` });
        seenBarcode.add(b);
      }
    });

    const existingSkus = await this.prisma.sku.findMany({
      where: { organizationId: actor.organizationId, code: { in: [...seenSku] } }, select: { code: true },
    });
    const existingBarcodes = await this.prisma.productBarcode.findMany({
      where: { organizationId: actor.organizationId, barcode: { in: [...seenBarcode] } }, select: { barcode: true },
    });
    existingSkus.forEach((s) => errors.push({ row: 0, message: `sku_code ${s.code} already exists` }));
    existingBarcodes.forEach((b) => errors.push({ row: 0, message: `barcode ${b.barcode} already exists` }));

    const groups = new Map<string, Record<string, string>[]>();
    for (const r of rows) groups.set(r.product_name, [...(groups.get(r.product_name) ?? []), r]);
    if (errors.length || dryRun) return { valid: errors.length === 0, products: groups.size, skus: rows.length, errors, imported: 0 };

    const categories = new Map((await this.categories(actor)).map((c) => [c.name.toLowerCase(), c]));
    const taxes = new Map((await this.taxCategories(actor)).map((t) => [t.code, t]));

    const imported = await this.prisma.$transaction(
      async (tx) => {
        let n = 0;
        for (const [name, skuRows] of groups) {
          const first = skuRows[0];
          const category = await this.ensureCategory(tx, actor, categories, first.category);
          const sub = first.subcategory ? await this.ensureCategory(tx, actor, categories, first.subcategory, category.id) : undefined;
          await this.insertProduct(tx, actor, {
            name,
            description: first.description || undefined,
            brand: first.brand || undefined,
            categoryId: category.id,
            subcategoryId: sub?.id,
            taxCategoryId: first.tax_code ? taxes.get(first.tax_code)?.id : undefined,
            storageCondition: (first.storage_condition || 'AMBIENT').toUpperCase() as any,
            shelfLifeDays: first.shelf_life_days ? Number(first.shelf_life_days) : undefined,
            status: (first.status || 'ACTIVE').toUpperCase() as any,
            skus: skuRows.map((r) => ({
              code: r.sku_code,
              variantName: r.variant_name || undefined,
              unit: (r.unit || 'EACH').toUpperCase() as any,
              netQuantity: r.net_quantity ? Number(r.net_quantity) : undefined,
              weightGrams: r.weight_grams ? Number(r.weight_grams) : undefined,
              mrp: Number(r.mrp),
              sellingPrice: Number(r.selling_price),
              purchasePrice: Number(r.purchase_price),
              reorderPoint: r.reorder_point ? Number(r.reorder_point) : undefined,
              reorderQty: r.reorder_qty ? Number(r.reorder_qty) : undefined,
              barcodes: (r.barcodes ?? '').split('|').filter(Boolean),
            })),
          });
          n++;
        }
        return n;
      },
      { timeout: 120_000 },
    );
    await this.audit.record({ actor, action: 'product.import', resourceType: 'product', after: { products: imported, skus: rows.length } });
    return { valid: true, products: groups.size, skus: rows.length, errors: [], imported };
  }

  async exportCsv(actor: AuthContext) {
    const products = await this.prisma.product.findMany({
      where: { organizationId: actor.organizationId, deletedAt: null },
      include: PRODUCT_INCLUDE,
      orderBy: { name: 'asc' },
    });
    const rows = products.flatMap((p) =>
      p.skus.map((s) => ({
        product_name: p.name, brand: p.brand?.name, category: p.category.name, subcategory: p.subcategory?.name,
        description: p.description, storage_condition: p.storageCondition, shelf_life_days: p.shelfLifeDays,
        sku_code: s.code, variant_name: s.variantName, unit: s.unit, net_quantity: s.netQuantity, weight_grams: s.weightGrams,
        mrp: s.mrp, selling_price: s.sellingPrice,
        purchase_price: hasPermission(actor, PERMISSIONS.PRICES_MANAGE) || hasPermission(actor, PERMISSIONS.PO_CREATE) ? s.purchasePrice : '',
        reorder_point: s.reorderPoint, reorder_qty: s.reorderQty,
        barcodes: s.barcodes.map((b) => b.barcode).join('|'), tax_code: p.taxCategory?.code, status: s.status,
      })),
    );
    return toCsv(CSV_COLUMNS, rows);
  }

  async addImage(actor: AuthContext, productId: string, objectKey: string, url: string) {
    await this.get(actor, productId);
    const count = await this.prisma.productImage.count({ where: { productId } });
    return this.prisma.productImage.create({ data: { productId, objectKey, url, sortOrder: count } });
  }

  // -------------------------------------------------------------- helpers

  private async insertProduct(tx: Tx, actor: AuthContext, dto: CreateProductDto) {
    const brand = dto.brand
      ? await tx.brand.upsert({
          where: { organizationId_name: { organizationId: actor.organizationId, name: dto.brand } },
          create: { organizationId: actor.organizationId, name: dto.brand },
          update: {},
        })
      : null;
    return tx.product.create({
      data: {
        organizationId: actor.organizationId,
        name: dto.name,
        description: dto.description,
        brandId: brand?.id,
        categoryId: dto.categoryId,
        subcategoryId: dto.subcategoryId,
        taxCategoryId: dto.taxCategoryId,
        storageCondition: dto.storageCondition,
        shelfLifeDays: dto.shelfLifeDays,
        batchTracked: dto.batchTracked,
        expiryTracked: dto.expiryTracked,
        status: dto.status,
        skus: {
          create: dto.skus.map(({ barcodes, ...s }) => ({
            ...s,
            organizationId: actor.organizationId,
            barcodes: {
              create: (barcodes ?? []).map((b, i) => ({
                organizationId: actor.organizationId, barcode: b, isPrimary: i === 0, symbology: isValidEan13(b) ? 'EAN13' : 'CODE128',
              })),
            },
          })),
        },
      },
      include: PRODUCT_INCLUDE,
    });
  }

  private async ensureCategory(tx: Tx, actor: AuthContext, cache: Map<string, any>, name: string, parentId?: string) {
    const key = name.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const c = await tx.productCategory.create({ data: { organizationId: actor.organizationId, name, slug: slugify(name), parentId } });
    cache.set(key, c);
    return c;
  }

  private assertPricing(skus: Pick<SkuInputDto, 'mrp' | 'sellingPrice'>[]) {
    for (const s of skus) {
      if (s.sellingPrice > s.mrp) throw new DomainError('PRICE_ABOVE_MRP', 'Selling price cannot exceed MRP', 400);
    }
  }

  /** SKU duplication detection: same code or any barcode already in use. */
  private async assertNoDuplicateSkus(orgId: string, skus: SkuInputDto[]) {
    const codes = skus.map((s) => s.code);
    const barcodes = skus.flatMap((s) => s.barcodes ?? []);
    if (new Set(codes).size !== codes.length) throw Conflict('DUPLICATE_SKU', 'Duplicate SKU codes in request');
    if (new Set(barcodes).size !== barcodes.length) throw Conflict('DUPLICATE_BARCODE', 'Duplicate barcodes in request');
    const [dupSku, dupBarcode] = await Promise.all([
      this.prisma.sku.findFirst({ where: { organizationId: orgId, code: { in: codes } } }),
      barcodes.length ? this.prisma.productBarcode.findFirst({ where: { organizationId: orgId, barcode: { in: barcodes } } }) : null,
    ]);
    if (dupSku) throw Conflict('DUPLICATE_SKU', `SKU code ${dupSku.code} already exists`);
    if (dupBarcode) throw Conflict('DUPLICATE_BARCODE', `Barcode ${dupBarcode.barcode} is already assigned`);
  }

  /** Purchase prices are commercially sensitive: hidden from roles without pricing/procurement rights. */
  private redact(actor: AuthContext, p: any) {
    if (hasPermission(actor, PERMISSIONS.PRICES_MANAGE) || hasPermission(actor, PERMISSIONS.PO_CREATE) || hasPermission(actor, PERMISSIONS.PO_APPROVE)) return p;
    return { ...p, skus: p.skus.map((s: any) => ({ ...s, purchasePrice: null })) };
  }
}
