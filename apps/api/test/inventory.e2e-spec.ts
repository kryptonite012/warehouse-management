import { closeWorld, createWorld, employee, key, sku, stock, warehouse, World } from './helpers';

describe('Inventory ledger (critical scenarios)', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); });
  afterAll(async () => closeWorld(w));

  async function balances(warehouseId: string, skuId: string) {
    const rows = await w.prisma.inventoryBalance.findMany({ where: { warehouseId, skuId } });
    return rows.reduce((a, r) => ({ onHand: a.onHand + r.onHand, available: a.available + r.available, reserved: a.reserved + r.reserved }), { onHand: 0, available: 0, reserved: 0 });
  }

  it('TEST 1: only one of many concurrent reservations for the last unit succeeds', async () => {
    const admin = await employee(w, ['ORG_ADMIN']);
    const store = await warehouse(w);
    const s = await sku(w);
    await stock(w, store.id, s.id, 1);

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        admin.call('post', '/inventory/reservations').send({ warehouseId: store.id, items: [{ skuId: s.id, quantity: 1 }], idempotencyKey: key() }),
      ),
    );
    const ok = attempts.filter((r) => r.status === 201);
    const rejected = attempts.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    expect(rejected[0].body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await balances(store.id, s.id)).toEqual({ onHand: 1, available: 0, reserved: 1 });
  });

  it('TEST 2: a reservation is released exactly once under concurrent release calls', async () => {
    const admin = await employee(w, ['ORG_ADMIN']);
    const store = await warehouse(w);
    const s = await sku(w);
    await stock(w, store.id, s.id, 5);
    const res = await admin.call('post', '/inventory/reservations').send({ warehouseId: store.id, items: [{ skuId: s.id, quantity: 3 }], idempotencyKey: key() }).expect(201);

    const releases = await Promise.all(
      Array.from({ length: 5 }, () => admin.call('post', `/inventory/reservations/${res.body.id}/release`).send({ reason: 'order cancelled' })),
    );
    expect(releases.filter((r) => r.body.released === true)).toHaveLength(1);
    expect(await balances(store.id, s.id)).toEqual({ onHand: 5, available: 5, reserved: 0 });
    const releaseMovements = await w.prisma.inventoryMovement.count({ where: { referenceId: res.body.id, movementType: 'RELEASE' } });
    expect(releaseMovements).toBe(1);
  });

  it('idempotent reservation: same key returns the same reservation and reserves once', async () => {
    const admin = await employee(w, ['ORG_ADMIN']);
    const store = await warehouse(w);
    const s = await sku(w);
    await stock(w, store.id, s.id, 10);
    const k = key();
    const a = await admin.call('post', '/inventory/reservations').send({ warehouseId: store.id, items: [{ skuId: s.id, quantity: 4 }], idempotencyKey: k }).expect(201);
    const b = await admin.call('post', '/inventory/reservations').send({ warehouseId: store.id, items: [{ skuId: s.id, quantity: 4 }], idempotencyKey: k }).expect(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await balances(store.id, s.id)).toEqual({ onHand: 10, available: 6, reserved: 4 });
  });

  it('TEST 5: FEFO picks the earliest-expiring valid batch and never an expired one', async () => {
    const admin = await employee(w, ['ORG_ADMIN']);
    const store = await warehouse(w);
    const s = await sku(w);
    const expired = await stock(w, store.id, s.id, 10, { batch: 'EXPIRED', expiresInDays: -1 });
    const soon = await stock(w, store.id, s.id, 2, { batch: 'SOON', expiresInDays: 2 });
    const later = await stock(w, store.id, s.id, 10, { batch: 'LATER', expiresInDays: 20 });

    const res = await admin.call('post', '/inventory/reservations').send({ warehouseId: store.id, items: [{ skuId: s.id, quantity: 5 }], idempotencyKey: key() }).expect(201);
    const byBatch = Object.fromEntries(res.body.lines.map((l: any) => [l.batchId, l.quantity]));
    expect(byBatch[soon.id]).toBe(2);
    expect(byBatch[later.id]).toBe(3);
    expect(byBatch[expired.id]).toBeUndefined();

    // Only expired stock left beyond what is valid -> request fails rather than selling expired goods.
    await admin.call('post', '/inventory/reservations').send({ warehouseId: store.id, items: [{ skuId: s.id, quantity: 8 }], idempotencyKey: key() }).expect(409);
  });

  it('TEST 6: a picker cannot adjust stock; the attempt is rejected and audited', async () => {
    const picker = await employee(w, ['PICKER']);
    const store = await warehouse(w);
    const s = await sku(w);
    const batch = await stock(w, store.id, s.id, 5);
    const res = await picker.call('post', '/inventory/adjustments').send({
      warehouseId: store.id, batchId: batch.id, bucket: 'AVAILABLE', quantityDelta: -5, reasonCode: 'WRITE_OFF',
    });
    expect(res.status).toBe(403);
    const denied = await w.prisma.auditLog.findFirst({ where: { actorId: picker.user.id, outcome: 'DENIED' } });
    expect(denied).not.toBeNull();
    expect(await balances(store.id, s.id)).toEqual({ onHand: 5, available: 5, reserved: 0 });
  });

  it('adjustments need a second person, and write-offs need inventory.write_off', async () => {
    const storeMgr = await employee(w, ['DARK_STORE_MANAGER']);
    const invMgr = await employee(w, ['INVENTORY_MANAGER']);
    const store = await warehouse(w);
    const s = await sku(w);
    const batch = await stock(w, store.id, s.id, 20);
    const adj = await storeMgr.call('post', '/inventory/adjustments').send({
      warehouseId: store.id, batchId: batch.id, bucket: 'AVAILABLE', quantityDelta: -4, reasonCode: 'WRITE_OFF',
    }).expect(201);
    await storeMgr.call('post', `/inventory/adjustments/${adj.body.id}/decision`).send({ approve: true }).expect(403); // own request
    const other = await employee(w, ['DARK_STORE_MANAGER']);
    await other.call('post', `/inventory/adjustments/${adj.body.id}/decision`).send({ approve: true }).expect(403); // lacks write_off
    await invMgr.call('post', `/inventory/adjustments/${adj.body.id}/decision`).send({ approve: true }).expect(201);
    expect(await balances(store.id, s.id)).toEqual({ onHand: 16, available: 16, reserved: 0 });
  });

  it('the database rejects ledger edits and negative balances directly', async () => {
    const store = await warehouse(w);
    const s = await sku(w);
    const batch = await stock(w, store.id, s.id, 1);
    await expect(w.prisma.inventoryMovement.deleteMany({ where: { batchId: batch.id } })).rejects.toThrow(/append-only/);
    await expect(w.prisma.inventoryBalance.update({ where: { batchId: batch.id }, data: { available: -1, onHand: 0, reserved: 1 } })).rejects.toThrow();
  });

  it('warehouse-scoped users cannot read other sites', async () => {
    const storeA = await warehouse(w);
    const storeB = await warehouse(w);
    const mgr = await employee(w, ['DARK_STORE_MANAGER'], { warehouseIds: [storeA.id] });
    await mgr.call('get', `/inventory?warehouseId=${storeA.id}`).expect(200);
    await mgr.call('get', `/inventory?warehouseId=${storeB.id}`).expect(403);
  });

  it('transfer moves stock through in-transit and records shortages', async () => {
    const admin = await employee(w, ['ORG_ADMIN']);
    const cw = await warehouse(w, 'CENTRAL_WAREHOUSE');
    const ds = await warehouse(w);
    const s = await sku(w);
    await stock(w, cw.id, s.id, 50);
    const t = await admin.call('post', '/inventory/transfers').send({ fromWarehouseId: cw.id, toWarehouseId: ds.id, items: [{ skuId: s.id, quantity: 20 }] }).expect(201);
    await admin.call('post', `/inventory/transfers/${t.body.id}/dispatch`).expect(201);
    const transit = await w.prisma.inventoryBalance.findMany({ where: { warehouseId: ds.id, skuId: s.id } });
    expect(transit.reduce((a, b) => a + b.inTransit, 0)).toBe(20);
    const rec = await admin.call('post', `/inventory/transfers/${t.body.id}/receive`).send({ lines: [{ itemId: t.body.items[0].id, receivedQty: 18 }] }).expect(201);
    expect(rec.body.shortages[0].short).toBe(2);
    expect(await balances(ds.id, s.id)).toEqual({ onHand: 18, available: 18, reserved: 0 });
    expect(await balances(cw.id, s.id)).toEqual({ onHand: 30, available: 30, reserved: 0 });
  });

  it('cycle count reconciliation books variances through the ledger', async () => {
    const counter = await employee(w, ['DARK_STORE_MANAGER']);
    const approver = await employee(w, ['INVENTORY_MANAGER']);
    const store = await warehouse(w);
    const s = await sku(w);
    await stock(w, store.id, s.id, 10);
    const c = await counter.call('post', '/inventory/counts').send({ warehouseId: store.id, skuIds: [s.id] }).expect(201);
    expect(c.body.items[0].systemQuantity).toBeUndefined(); // blind count
    await counter.call('post', `/inventory/counts/${c.body.id}/submit`).send({ lines: [{ itemId: c.body.items[0].id, countedQuantity: 7 }] }).expect(201);
    await counter.call('post', `/inventory/counts/${c.body.id}/reconcile`).expect(403);
    const r = await approver.call('post', `/inventory/counts/${c.body.id}/reconcile`).expect(201);
    expect(r.body.corrections[0].variance).toBe(-3);
    expect(await balances(store.id, s.id)).toEqual({ onHand: 7, available: 7, reserved: 0 });
  });
});
