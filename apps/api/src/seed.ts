/**
 * Seeds permissions, default roles and a bootstrap organization + super admin.
 * With SEED_DEMO=true it also creates clearly-labelled DEMO sites, catalog and stock.
 *
 *   SEED_ADMIN_EMAIL=admin@example.com SEED_ADMIN_PASSWORD='...' npm run db:seed   (or: docker compose run --rm api seed)
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { ALL_PERMISSIONS, DEFAULT_ROLES } from './common/permissions';

const prisma = new PrismaClient();

/** Idempotent and safe to run concurrently (single INSERT … ON CONFLICT DO NOTHING). */
export async function seedPermissions(db: PrismaClient) {
  await db.permission.createMany({
    data: ALL_PERMISSIONS.map((code) => ({ code, module: code.split('.')[0] })),
    skipDuplicates: true,
  });
}

export async function seedOrganization(db: PrismaClient, code: string, name: string) {
  await db.organization.createMany({ data: [{ code, name }], skipDuplicates: true });
  const org = await db.organization.findUniqueOrThrow({ where: { code } });
  const perms = await db.permission.findMany();
  const byCode = new Map(perms.map((p) => [p.code, p.id]));
  for (const [roleCode, def] of Object.entries(DEFAULT_ROLES)) {
    await db.role.createMany({ data: [{ organizationId: org.id, code: roleCode, name: def.name, isSystem: true }], skipDuplicates: true });
    const role = await db.role.findUniqueOrThrow({ where: { organizationId_code: { organizationId: org.id, code: roleCode } } });
    await db.rolePermission.createMany({
      data: def.permissions.map((p) => ({ roleId: role.id, permissionId: byCode.get(p)! })),
      skipDuplicates: true,
    });
  }
  return org;
}

async function seedDemo(orgId: string) {
  const exists = await prisma.warehouse.findFirst({ where: { organizationId: orgId, code: 'DEMO-CW1' } });
  if (exists) return console.log('demo data already present');

  const cw = await prisma.warehouse.create({
    data: {
      organizationId: orgId, code: 'DEMO-CW1', name: 'DEMO Central Warehouse', type: 'CENTRAL_WAREHOUSE',
      addressLine1: 'Plot 12, Logistics Park', city: 'Bengaluru', state: 'KA', postalCode: '562123',
      latitude: 13.2, longitude: 77.6, capacityUnits: 500000, temperatureZones: ['AMBIENT', 'CHILLED'],
    },
  });
  const ds = await prisma.warehouse.create({
    data: {
      organizationId: orgId, code: 'DEMO-DS1', name: 'DEMO Dark Store Indiranagar', type: 'DARK_STORE',
      addressLine1: '100 Feet Road', city: 'Bengaluru', state: 'KA', postalCode: '560038',
      latitude: 12.9719, longitude: 77.6412, capacityUnits: 15000, temperatureZones: ['AMBIENT', 'CHILLED'],
      darkStore: { create: { supplyingWarehouseId: cw.id, serviceRadiusKm: 3, servicePostalCodes: ['560038', '560008', '560071'] } },
    },
  });
  const tax = await prisma.taxCategory.create({ data: { organizationId: orgId, code: 'GST5', name: 'GST 5%', ratePercent: 5 } });
  const dairy = await prisma.productCategory.create({ data: { organizationId: orgId, name: 'Dairy', slug: 'dairy' } });
  const snacks = await prisma.productCategory.create({ data: { organizationId: orgId, name: 'Snacks', slug: 'snacks' } });

  const items = [
    { name: 'DEMO Toned Milk 500ml', cat: dairy.id, storage: 'CHILLED', code: 'DEMO-MILK-500', mrp: 30, sp: 29, pp: 24, bc: '8900000000011', life: 3 },
    { name: 'DEMO Curd 400g', cat: dairy.id, storage: 'CHILLED', code: 'DEMO-CURD-400', mrp: 45, sp: 42, pp: 34, bc: '8900000000028', life: 10 },
    { name: 'DEMO Salted Chips 52g', cat: snacks.id, storage: 'AMBIENT', code: 'DEMO-CHIPS-52', mrp: 20, sp: 20, pp: 14, bc: '8900000000035', life: 120 },
    { name: 'DEMO Digestive Biscuits 250g', cat: snacks.id, storage: 'AMBIENT', code: 'DEMO-BISC-250', mrp: 60, sp: 55, pp: 41, bc: '8900000000042', life: 180 },
  ] as const;

  for (const it of items) {
    const p = await prisma.product.create({
      data: {
        organizationId: orgId, name: it.name, categoryId: it.cat, taxCategoryId: tax.id, storageCondition: it.storage as any, shelfLifeDays: it.life,
        skus: { create: { organizationId: orgId, code: it.code, mrp: it.mrp, sellingPrice: it.sp, purchasePrice: it.pp, reorderPoint: 10, reorderQty: 60,
          barcodes: { create: { organizationId: orgId, barcode: it.bc, isPrimary: true } } } },
      },
      include: { skus: true },
    });
    // Opening stock is booked through the ledger (movement + balance), never as a bare balance.
    for (const wh of [cw, ds]) {
      const qty = wh.id === cw.id ? 500 : 40;
      const batch = await prisma.inventoryBatch.create({
        data: { organizationId: orgId, warehouseId: wh.id, skuId: p.skus[0].id, batchNumber: 'DEMO-OPENING',
          expiresAt: new Date(Date.now() + it.life * 86_400_000), unitCost: it.pp },
      });
      await prisma.$transaction([
        prisma.inventoryBalance.create({ data: { organizationId: orgId, warehouseId: wh.id, skuId: p.skus[0].id, batchId: batch.id, onHand: qty, available: qty } }),
        prisma.inventoryMovement.create({
          data: { organizationId: orgId, warehouseId: wh.id, skuId: p.skus[0].id, batchId: batch.id, movementType: 'ADJUSTMENT_IN',
            fromBucket: 'NONE', toBucket: 'AVAILABLE', quantity: qty, referenceType: 'demo_seed', referenceId: batch.id, actorType: 'SYSTEM',
            reason: 'DEMO opening stock', idempotencyKey: `demo-opening:${batch.id}` },
        }),
      ]);
    }
  }
  await prisma.supplier.create({
    data: { organizationId: orgId, code: 'DEMO-SUP1', name: 'DEMO Fresh Dairy Suppliers', gstin: '29ABCDE1234F1Z5', leadTimeDays: 1, paymentTermsDays: 15 },
  });
  console.log(`demo data created: ${cw.code}, ${ds.code}, ${items.length} products`);
}

async function main() {
  await seedPermissions(prisma);
  const org = await seedOrganization(prisma, process.env.SEED_ORG_CODE ?? 'QS', process.env.SEED_ORG_NAME ?? 'QuickStore');

  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (email && password) {
    if (password.length < 12) throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters');
    await prisma.user.upsert({
      where: { email: email.toLowerCase() },
      create: { organizationId: org.id, email: email.toLowerCase(), fullName: 'Platform Administrator', passwordHash: await bcrypt.hash(password, 12), isSuperAdmin: true },
      update: {},
    });
    console.log(`super admin ready: ${email}`);
  } else {
    console.log('SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set: no admin user created');
  }
  if (process.env.SEED_DEMO === 'true') await seedDemo(org.id);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
}
