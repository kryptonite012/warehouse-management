import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthContext } from '../../common/auth-context';
import { DomainError, NotFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { LedgerService } from '../inventory/ledger.service';
import { StoreAllocationService } from './store-allocation.service';

/** Customer-facing catalog: prices and availability come straight from the ledger. */
@Injectable()
export class StorefrontService {
  constructor(private readonly prisma: PrismaService, private readonly ledger: LedgerService, private readonly allocation: StoreAllocationService) {}

  async serviceability(organizationId: string, postalCode: string, latitude?: number, longitude?: number) {
    const stores = await this.allocation.serviceableStores(organizationId, { postalCode, latitude, longitude });
    if (!stores.length) return { serviceable: false, stores: [] };
    stores.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    return {
      serviceable: true,
      // ETA is intentionally not fabricated: no routing provider is configured.
      etaMinutes: null,
      etaSource: process.env.ROUTING_PROVIDER ? process.env.ROUTING_PROVIDER : 'NOT_CONFIGURED',
      stores: stores.map((s) => ({ id: s.store.id, name: s.store.name, distanceKm: s.distanceKm !== null ? Number(s.distanceKm.toFixed(2)) : null })),
    };
  }

  categories(organizationId: string) {
    return this.prisma.productCategory.findMany({
      where: { organizationId, products: { some: { status: 'ACTIVE' } } },
      select: { id: true, name: true, slug: true, parentId: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async products(organizationId: string, storeId: string, opts: { categoryId?: string; search?: string; page: number; pageSize: number }) {
    await this.assertStore(organizationId, storeId);
    const where: Prisma.ProductWhereInput = {
      organizationId, status: 'ACTIVE', deletedAt: null,
      OR: opts.categoryId ? [{ categoryId: opts.categoryId }, { subcategoryId: opts.categoryId }] : undefined,
      name: opts.search ? { contains: opts.search, mode: 'insensitive' } : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: { brand: true, images: { take: 1, orderBy: { sortOrder: 'asc' } }, skus: { where: { status: 'ACTIVE' }, orderBy: { sellingPrice: 'asc' } } },
        orderBy: { name: 'asc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);
    const avail = await this.ledger.availability(storeId, rows.flatMap((p) => p.skus.map((s) => s.id)));
    return {
      data: rows.map((p) => this.shape(p, avail)),
      meta: { page: opts.page, pageSize: opts.pageSize, total, totalPages: Math.ceil(total / opts.pageSize) },
    };
  }

  async product(organizationId: string, storeId: string, productId: string) {
    await this.assertStore(organizationId, storeId);
    const p = await this.prisma.product.findFirst({
      where: { id: productId, organizationId, status: 'ACTIVE' },
      include: { brand: true, category: true, images: { orderBy: { sortOrder: 'asc' } }, skus: { where: { status: 'ACTIVE' } } },
    });
    if (!p) throw NotFound('Product', productId);
    const avail = await this.ledger.availability(storeId, p.skus.map((s) => s.id));
    // Substitutes: same category, in stock at this store.
    const similar = await this.prisma.product.findMany({
      where: { organizationId, status: 'ACTIVE', categoryId: p.categoryId, id: { not: p.id } },
      include: { brand: true, images: { take: 1 }, skus: { where: { status: 'ACTIVE' } } },
      take: 12,
    });
    const simAvail = await this.ledger.availability(storeId, similar.flatMap((s) => s.skus.map((k) => k.id)));
    return {
      ...this.shape(p, avail),
      description: p.description,
      category: { id: p.category.id, name: p.category.name },
      images: p.images,
      substitutes: similar.map((s) => this.shape(s, simAvail)).filter((s) => s.inStock).slice(0, 6),
    };
  }

  // ------------------------------------------------------------------ cart

  async cart(actor: AuthContext, storeId?: string) {
    const cart = await this.prisma.cart.findFirst({ where: { customerId: actor.id, status: 'OPEN' }, include: { items: true } });
    if (!cart) return { id: null, items: [], subtotal: 0 };
    const skus = await this.prisma.sku.findMany({ where: { id: { in: cart.items.map((i) => i.skuId) } }, include: { product: { select: { name: true } } } });
    const avail = storeId ? await this.ledger.availability(storeId, skus.map((s) => s.id)) : null;
    const items = cart.items.map((i) => {
      const s = skus.find((k) => k.id === i.skuId)!;
      return {
        skuId: i.skuId, quantity: i.quantity, name: s.product.name, variant: s.variantName, unitPrice: Number(s.sellingPrice), mrp: Number(s.mrp),
        lineTotal: Number(s.sellingPrice) * i.quantity, available: avail ? avail.get(i.skuId) ?? 0 : null,
      };
    });
    return { id: cart.id, items, subtotal: Math.round(items.reduce((a, i) => a + i.lineTotal, 0) * 100) / 100 };
  }

  async setCartItem(actor: AuthContext, skuId: string, quantity: number) {
    const sku = await this.prisma.sku.findFirst({ where: { id: skuId, organizationId: actor.organizationId, status: 'ACTIVE' } });
    if (!sku) throw NotFound('Product', skuId);
    const cart =
      (await this.prisma.cart.findFirst({ where: { customerId: actor.id, status: 'OPEN' } })) ??
      (await this.prisma.cart.create({ data: { customerId: actor.id } }));
    if (quantity === 0) await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id, skuId } });
    else {
      const count = await this.prisma.cartItem.count({ where: { cartId: cart.id } });
      if (count >= 100) throw new DomainError('CART_FULL', 'Cart can hold at most 100 products', 400);
      await this.prisma.cartItem.upsert({ where: { cartId_skuId: { cartId: cart.id, skuId } }, create: { cartId: cart.id, skuId, quantity }, update: { quantity } });
    }
    return this.cart(actor);
  }

  async clearCart(actor: AuthContext) {
    await this.prisma.cart.updateMany({ where: { customerId: actor.id, status: 'OPEN' }, data: { status: 'ABANDONED' } });
  }

  private async assertStore(organizationId: string, storeId: string) {
    const s = await this.prisma.warehouse.findFirst({ where: { id: storeId, organizationId, type: 'DARK_STORE', status: 'ACTIVE' } });
    if (!s) throw NotFound('Store', storeId);
  }

  private shape(p: any, avail: Map<string, number>) {
    const variants = p.skus.map((s: any) => {
      const available = avail.get(s.id) ?? 0;
      return {
        skuId: s.id, code: s.code, variantName: s.variantName, unit: s.unit, netQuantity: Number(s.netQuantity),
        mrp: Number(s.mrp), sellingPrice: Number(s.sellingPrice),
        discountPercent: Number(s.mrp) > 0 ? Math.round((1 - Number(s.sellingPrice) / Number(s.mrp)) * 100) : 0,
        available, inStock: available > 0, maxPerOrder: Math.min(available, 10),
      };
    });
    return {
      id: p.id, name: p.name, brand: p.brand?.name ?? null, image: p.images?.[0]?.url ?? null,
      storageCondition: p.storageCondition, variants, inStock: variants.some((v: any) => v.inStock),
    };
  }
}
