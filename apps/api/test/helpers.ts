import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { seedOrganization, seedPermissions } from '../../../database/seed/seed';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';

export const PASSWORD = 'Str0ngPassw0rd!';

export interface World {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  prisma: PrismaClient;
  orgId: string;
}

export async function createWorld(): Promise<World> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const prisma = new PrismaClient();
  await seedPermissions(prisma);
  const org = await seedOrganization(prisma, `T${randomUUID().slice(0, 6).toUpperCase()}`, 'Test Org');
  return { app, http: () => request(app.getHttpServer()), prisma, orgId: org.id };
}

export async function closeWorld(w: World) {
  await w.prisma.$disconnect();
  await w.app.close();
}

/** Creates an employee with the given role codes and returns an authed agent helper. */
export async function employee(
  w: World,
  roles: string[],
  opts: { superAdmin?: boolean; warehouseIds?: string[] } = {},
) {
  const email = `${randomUUID().slice(0, 8)}@test.local`;
  const roleRows = await w.prisma.role.findMany({ where: { organizationId: w.orgId, code: { in: roles } } });
  const user = await w.prisma.user.create({
    data: {
      organizationId: w.orgId, email, fullName: `User ${roles.join('+') || 'admin'}`, passwordHash: await bcrypt.hash(PASSWORD, 4),
      isSuperAdmin: opts.superAdmin ?? false,
      roles: { create: roleRows.map((r) => ({ roleId: r.id })) },
      scopes: { create: (opts.warehouseIds ?? []).map((id) => ({ scopeType: 'WAREHOUSE' as const, scopeId: id })) },
    },
  });
  const res = await w.http().post('/api/v1/auth/login').send({ identifier: email, password: PASSWORD }).expect(200);
  const token = res.body.accessToken as string;
  const call = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) =>
    w.http()[method](`/api/v1${url}`).set('Authorization', `Bearer ${token}`);
  return { user, token, refreshToken: res.body.refreshToken as string, email, call };
}

export async function warehouse(w: World, type: 'CENTRAL_WAREHOUSE' | 'DARK_STORE' = 'DARK_STORE', extra: Record<string, any> = {}) {
  const code = `W${randomUUID().slice(0, 6).toUpperCase()}`;
  return w.prisma.warehouse.create({
    data: {
      organizationId: w.orgId, code, name: `Site ${code}`, type, addressLine1: '1 Test Rd', city: 'Bengaluru', state: 'KA',
      postalCode: '560038', latitude: 12.97, longitude: 77.64,
      darkStore: type === 'DARK_STORE' ? { create: { servicePostalCodes: ['560038'], serviceRadiusKm: 3, ...(extra.darkStore ?? {}) } } : undefined,
    },
    include: { darkStore: true },
  });
}

let catSeq = 0;
export async function sku(w: World, opts: { price?: number; storage?: 'AMBIENT' | 'CHILLED' } = {}) {
  const cat = await w.prisma.productCategory.create({ data: { organizationId: w.orgId, name: `Cat ${++catSeq}`, slug: `cat-${randomUUID().slice(0, 8)}` } });
  const code = `SKU-${randomUUID().slice(0, 8).toUpperCase()}`;
  const product = await w.prisma.product.create({
    data: {
      organizationId: w.orgId, name: `Product ${code}`, categoryId: cat.id, storageCondition: opts.storage ?? 'AMBIENT',
      skus: { create: { organizationId: w.orgId, code, mrp: (opts.price ?? 50) + 5, sellingPrice: opts.price ?? 50, purchasePrice: (opts.price ?? 50) * 0.7,
        barcodes: { create: { organizationId: w.orgId, barcode: `BC${randomUUID().replace(/-/g, '').slice(0, 12)}`, isPrimary: true } } } },
    },
    include: { skus: { include: { barcodes: true } } },
  });
  return product.skus[0];
}

/** Books opening stock through the ledger tables (movement + balance). */
export async function stock(w: World, warehouseId: string, skuId: string, qty: number, opts: { batch?: string; expiresInDays?: number | null } = {}) {
  const batch = await w.prisma.inventoryBatch.create({
    data: {
      organizationId: w.orgId, warehouseId, skuId, batchNumber: opts.batch ?? `B-${randomUUID().slice(0, 6)}`,
      expiresAt: opts.expiresInDays === null ? null : new Date(Date.now() + (opts.expiresInDays ?? 30) * 86_400_000),
    },
  });
  await w.prisma.inventoryBalance.create({ data: { organizationId: w.orgId, warehouseId, skuId, batchId: batch.id, onHand: qty, available: qty } });
  await w.prisma.inventoryMovement.create({
    data: { organizationId: w.orgId, warehouseId, skuId, batchId: batch.id, movementType: 'ADJUSTMENT_IN', fromBucket: 'NONE', toBucket: 'AVAILABLE',
      quantity: qty, referenceType: 'test', referenceId: batch.id, actorType: 'SYSTEM', idempotencyKey: `test-open:${batch.id}` },
  });
  return batch;
}

export const key = () => `k-${randomUUID()}`;
