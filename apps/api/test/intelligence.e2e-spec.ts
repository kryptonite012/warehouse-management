import { closeWorld, createWorld, employee, sku, stock, warehouse, World } from './helpers';

describe('Intelligence (engine optional)', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); });
  afterAll(async () => closeWorld(w));

  it('falls back to a labelled rule when the engine is unavailable and recommends replenishment', async () => {
    const admin = await employee(w, ['ORG_ADMIN']);
    const cw = await warehouse(w, 'CENTRAL_WAREHOUSE');
    const store = await warehouse(w, 'DARK_STORE', { darkStore: { supplyingWarehouseId: cw.id } });
    const s = await sku(w);
    await stock(w, store.id, s.id, 3); // below default reorder point of 10
    await stock(w, cw.id, s.id, 500);

    const run = await admin.call('post', '/intelligence/forecasts/run').send({ warehouseId: store.id, horizonDays: 7 }).expect(201);
    if (!process.env.AI_ENGINE_URL) expect(run.body.method).toMatch(/^rule:/);
    const f = await admin.call('get', `/intelligence/forecasts?warehouseId=${store.id}`).expect(200);
    expect(f.body[0]).toEqual(expect.objectContaining({ modelVersion: expect.any(String), dataPeriod: expect.any(Object), lastUpdate: expect.any(String) }));
    if (!process.env.AI_ENGINE_URL) {
      expect(f.body[0].isModelPrediction).toBe(false);
      expect(f.body[0].confidence).toBeNull();
    }

    await admin.call('post', '/intelligence/replenishment/run').send({ warehouseId: store.id }).expect(201);
    const recs = await admin.call('get', `/intelligence/replenishment?warehouseId=${store.id}`).expect(200);
    expect(recs.body.length).toBeGreaterThanOrEqual(1);
    const transfer = await admin.call('post', '/intelligence/replenishment/accept').send({ ids: recs.body.map((r: any) => r.id) }).expect(201);
    expect(transfer.body.fromWarehouseId).toBe(cw.id);
    expect(transfer.body.status).toBe('DRAFT');
  });
});
