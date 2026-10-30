import { randomUUID } from 'crypto';
import { closeWorld, createWorld, employee, sku, stock, warehouse, World } from './helpers';

describe('Offline synchronisation (edge -> central)', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); });
  afterAll(async () => closeWorld(w));

  async function device(storeId: string, ops = ['DAMAGE_REPORT', 'COUNT_SUBMIT', 'PICK_SCAN', 'TRANSFER_RECEIVE']) {
    const mgr = await employee(w, ['DARK_STORE_MANAGER'], { warehouseIds: [storeId] });
    const d = await mgr.call('post', '/sync/devices').send({ warehouseId: storeId, name: 'Store tablet', allowedOps: ops }).expect(201);
    const push = (operations: any[]) => w.http().post('/api/v1/sync/push').set('x-device-token', d.body.token).send({ operations });
    return { mgr, token: d.body.token as string, push };
  }

  it('TEST 4: queued operations replayed after reconnect are applied exactly once', async () => {
    const store = await warehouse(w);
    const s = await sku(w);
    const batch = await stock(w, store.id, s.id, 10);
    const { mgr, token, push } = await device(store.id);

    const snap = await w.http().get('/api/v1/sync/snapshot').set('x-device-token', token).expect(200);
    expect(snap.body.inventoryIsAdvisory).toBe(true);
    expect(snap.body.balances.find((b: any) => b.batchId === batch.id).available).toBe(10);

    const queued = [1, 2, 3].map((n) => ({
      clientOpId: randomUUID(), sequence: n, opType: 'DAMAGE_REPORT', occurredAt: new Date().toISOString(),
      performedBy: mgr.user.id, payload: { batchId: batch.id, quantity: 1, reason: `crushed ${n}` },
    }));
    // The agent retries the same batch three times (flaky link) and concurrently.
    const results = await Promise.all([push(queued), push(queued), push(queued)]);
    results.forEach((r) => expect(r.status).toBe(200));
    const bal = await w.prisma.inventoryBalance.findUniqueOrThrow({ where: { batchId: batch.id } });
    expect(bal).toMatchObject({ available: 7, damaged: 3 });
    expect(await w.prisma.syncOperation.count({ where: { clientOpId: { in: queued.map((q) => q.clientOpId) } } })).toBe(3);
    const store2 = await w.prisma.darkStore.findUniqueOrThrow({ where: { id: store.id } });
    expect(store2.lastSyncAt).not.toBeNull();
  });

  it('detects conflicts instead of overwriting central stock (no last-write-wins)', async () => {
    const store = await warehouse(w);
    const s = await sku(w);
    const batch = await stock(w, store.id, s.id, 2);
    const { mgr, push } = await device(store.id);
    // While the store was offline, central sold both units.
    const central = await employee(w, ['ORG_ADMIN']);
    await central.call('post', '/inventory/reservations').send({ warehouseId: store.id, items: [{ skuId: s.id, quantity: 2 }], idempotencyKey: `res-${randomUUID()}` }).expect(201);

    const res = await push([{ clientOpId: randomUUID(), sequence: 1, opType: 'DAMAGE_REPORT', occurredAt: new Date().toISOString(), performedBy: mgr.user.id, payload: { batchId: batch.id, quantity: 1, reason: 'dropped' } }]).expect(200);
    expect(res.body.results[0].status).toBe('CONFLICT');
    const bal = await w.prisma.inventoryBalance.findUniqueOrThrow({ where: { batchId: batch.id } });
    expect(bal).toMatchObject({ available: 0, reserved: 2, damaged: 0 });

    const conflicts = await mgr.call('get', `/sync/conflicts?warehouseId=${store.id}`).expect(200);
    expect(conflicts.body).toHaveLength(1);
    await mgr.call('post', `/sync/conflicts/${conflicts.body[0].id}/resolve`).send({ action: 'DISMISS', note: 'stock was sold; damage recorded on next count' }).expect(201);
    expect((await mgr.call('get', `/sync/conflicts?warehouseId=${store.id}`).expect(200)).body).toHaveLength(0);
  });

  it('rejects operations not authorised for offline use or by unauthorised staff', async () => {
    const store = await warehouse(w);
    const s = await sku(w);
    const batch = await stock(w, store.id, s.id, 5);
    const { push } = await device(store.id, ['PICK_SCAN']);
    const picker = await employee(w, ['PICKER'], { warehouseIds: [store.id] });
    const r = await push([
      { clientOpId: randomUUID(), sequence: 1, opType: 'DAMAGE_REPORT', occurredAt: new Date().toISOString(), performedBy: picker.user.id, payload: { batchId: batch.id, quantity: 1 } },
    ]).expect(200);
    expect(r.body.results[0].status).toBe('REJECTED');
    await w.http().post('/api/v1/sync/push').set('x-device-token', 'bogus').send({ operations: [] }).expect(401);
  });
});

describe('Reports and concurrency policy', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); });
  afterAll(async () => closeWorld(w));

  it('overview KPIs are computed from live data', async () => {
    const admin = await employee(w, ['ORG_ADMIN']);
    const store = await warehouse(w);
    const s = await sku(w);
    await stock(w, store.id, s.id, 5);
    const r = await admin.call('get', '/reports/overview').expect(200);
    expect(r.body.dataSource).toBe('live');
    expect(r.body.sites.activeDarkStores).toBeGreaterThanOrEqual(1);
    expect(r.body.catalog.totalSkus).toBeGreaterThanOrEqual(1);
    await admin.call('get', '/reports/sales?granularity=hour').expect(200);
    await admin.call('get', '/reports/inventory').expect(200);
    await admin.call('get', '/reports/fulfillment').expect(200);
    await admin.call('get', '/reports/procurement').expect(200);
    await admin.call('get', '/reports/warehouse').expect(200);
  });

  it('TEST 9: conflicting manager edits are rejected via optimistic concurrency', async () => {
    const m1 = await employee(w, ['ORG_ADMIN']);
    const m2 = await employee(w, ['ORG_ADMIN']);
    const store = await warehouse(w);
    const [a, b] = await Promise.all([
      m1.call('patch', `/warehouses/${store.id}`).send({ version: 1, name: 'Renamed by manager 1' }),
      m2.call('patch', `/warehouses/${store.id}`).send({ version: 1, name: 'Renamed by manager 2' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('STALE_VERSION');
    const final = await w.prisma.warehouse.findUniqueOrThrow({ where: { id: store.id } });
    expect(final.version).toBe(2);
  });

  it('audit log records privileged actions and settings changes', async () => {
    const admin = await employee(w, ['ORG_ADMIN']);
    await admin.call('put', '/settings').send({ key: 'fulfillment.require_barcode_scan', value: true }).expect(200);
    await admin.call('put', '/settings').send({ key: 'fulfillment.require_barcode_scan', value: 'yes' }).expect(400);
    const logs = await admin.call('get', '/audit-logs?search=settings').expect(200);
    expect(logs.body.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Disconnected stores are not offered to customers', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); });
  afterAll(async () => closeWorld(w));

  it('skips a dark store whose edge agent has gone silent', async () => {
    const orgCode = (await w.prisma.organization.findUniqueOrThrow({ where: { id: w.orgId } })).code;
    const store = await warehouse(w);
    await w.prisma.darkStore.update({ where: { id: store.id }, data: { servicePostalCodes: ['560111'] } });
    const mgr = await employee(w, ['DARK_STORE_MANAGER'], { warehouseIds: [store.id] });
    const d = await mgr.call('post', '/sync/devices').send({ warehouseId: store.id, name: 'tablet', allowedOps: ['PICK_SCAN'] }).expect(201);
    await w.http().get('/api/v1/sync/snapshot').set('x-device-token', d.body.token).expect(200);
    const online = await w.http().get(`/api/v1/storefront/serviceability?postalCode=560111&org=${orgCode}`).expect(200);
    expect(online.body.stores.map((s: any) => s.id)).toContain(store.id);

    await w.prisma.edgeDevice.updateMany({ where: { warehouseId: store.id }, data: { lastSeenAt: new Date(Date.now() - 3_600_000) } });
    const offline = await w.http().get(`/api/v1/storefront/serviceability?postalCode=560111&org=${orgCode}`).expect(200);
    expect(offline.body.serviceable).toBe(false);
  });
});
