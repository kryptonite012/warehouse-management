import { closeWorld, createWorld, employee, key, sku, warehouse, World } from './helpers';

describe('Procurement & receiving', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); });
  afterAll(async () => closeWorld(w));

  const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

  async function approvedPo(qty: number) {
    const buyer = await employee(w, ['PROCUREMENT_MANAGER']);
    const approver = await employee(w, ['PROCUREMENT_MANAGER']);
    const receiver = await employee(w, ['WAREHOUSE_MANAGER']);
    const cw = await warehouse(w, 'CENTRAL_WAREHOUSE');
    const s = await sku(w);
    const sup = await buyer.call('post', '/suppliers').send({ code: `S${Date.now() % 100000}`, name: 'Fresh Foods', gstin: '29ABCDE1234F1Z5' }).expect(201);
    const po = await buyer.call('post', '/purchase-orders').send({ supplierId: sup.body.id, warehouseId: cw.id, items: [{ skuId: s.id, orderedQty: qty, unitCost: 10 }] }).expect(201);
    await buyer.call('post', `/purchase-orders/${po.body.id}/submit`).expect(201);
    await buyer.call('post', `/purchase-orders/${po.body.id}/approve`).expect(403); // creator cannot approve
    await approver.call('post', `/purchase-orders/${po.body.id}/approve`).expect(201);
    return { po: po.body, s, cw, receiver, buyer, approver };
  }

  it('TEST 7: partial shipment records received and pending quantities correctly', async () => {
    const { po, s, cw, receiver } = await approvedPo(100);
    const grn = await receiver.call('post', '/goods-receipts').send({
      purchaseOrderId: po.id, idempotencyKey: key(), items: [{ skuId: s.id, batchNumber: 'LOT-A', expiresAt: inDays(30), receivedQty: 60, unitCost: 11 }],
    }).expect(201);
    expect(grn.body.discrepancies).toEqual([expect.objectContaining({ type: 'PRICE', poUnitCost: 10, invoicedUnitCost: 11 })]);

    let detail = await receiver.call('get', `/purchase-orders/${po.id}`).expect(200);
    expect(detail.body.status).toBe('PARTIALLY_RECEIVED');
    expect(detail.body.items[0]).toMatchObject({ orderedQty: 100, receivedQty: 60, pendingQty: 40 });

    // Received stock is quarantined until QC, so it is not sellable yet.
    let bal = await w.prisma.inventoryBalance.findFirstOrThrow({ where: { warehouseId: cw.id, skuId: s.id } });
    expect(bal).toMatchObject({ quarantined: 60, available: 0 });

    await receiver.call('post', `/goods-receipts/${grn.body.id}/complete`).expect(409); // inspection pending
    await receiver.call('post', `/goods-receipts/${grn.body.id}/inspect`).send({
      lines: [{ itemId: grn.body.items[0].id, acceptedQty: 55, rejectedQty: 3, damagedQty: 2, rejectionReason: 'torn packaging' }],
    }).expect(201);
    await receiver.call('post', `/goods-receipts/${grn.body.id}/complete`).expect(201);
    bal = await w.prisma.inventoryBalance.findFirstOrThrow({ where: { warehouseId: cw.id, skuId: s.id } });
    expect(bal).toMatchObject({ quarantined: 0, available: 55, damaged: 2, onHand: 55 });

    // Over-receipt beyond the outstanding 40 units is rejected.
    await receiver.call('post', '/goods-receipts').send({
      purchaseOrderId: po.id, idempotencyKey: key(), items: [{ skuId: s.id, batchNumber: 'LOT-B', expiresAt: inDays(30), receivedQty: 41 }],
    }).expect(409);
    await receiver.call('post', '/goods-receipts').send({
      purchaseOrderId: po.id, idempotencyKey: key(), items: [{ skuId: s.id, batchNumber: 'LOT-B', expiresAt: inDays(30), receivedQty: 40 }],
    }).expect(201);
    detail = await receiver.call('get', `/purchase-orders/${po.id}`).expect(200);
    expect(detail.body.status).toBe('RECEIVED');
    expect(detail.body.items[0]).toMatchObject({ receivedQty: 100, acceptedQty: 55, rejectedQty: 5, pendingQty: 0 });
  });

  it('goods receipt is idempotent on retry', async () => {
    const { po, s, receiver } = await approvedPo(10);
    const k = key();
    const body = { purchaseOrderId: po.id, idempotencyKey: k, items: [{ skuId: s.id, batchNumber: 'LOT-R', expiresAt: inDays(10), receivedQty: 5 }] };
    const a = await receiver.call('post', '/goods-receipts').send(body).expect(201);
    const b = await receiver.call('post', '/goods-receipts').send(body).expect(201);
    expect(b.body.id).toBe(a.body.id);
    const detail = await receiver.call('get', `/purchase-orders/${po.id}`).expect(200);
    expect(detail.body.items[0].receivedQty).toBe(5);
  });

  it('rejects expired batches at receipt and enforces approval limits', async () => {
    const { po, s, receiver } = await approvedPo(10);
    await receiver.call('post', '/goods-receipts').send({
      purchaseOrderId: po.id, idempotencyKey: key(), items: [{ skuId: s.id, batchNumber: 'OLD', expiresAt: inDays(-1), receivedQty: 5 }],
    }).expect(400);

    await w.prisma.systemSetting.create({ data: { organizationId: w.orgId, key: 'procurement.approval_limits', value: { PROCUREMENT_MANAGER: 50 } } });
    const buyer = await employee(w, ['PROCUREMENT_MANAGER']);
    const approver = await employee(w, ['PROCUREMENT_MANAGER']);
    const big = await buyer.call('post', '/purchase-orders').send({ supplierId: po.supplierId, warehouseId: po.warehouseId, items: [{ skuId: s.id, orderedQty: 100, unitCost: 10 }] }).expect(201);
    await buyer.call('post', `/purchase-orders/${big.body.id}/submit`).expect(201);
    const denied = await approver.call('post', `/purchase-orders/${big.body.id}/approve`).expect(403);
    expect(denied.body.error.message).toMatch(/approval limit/);
    await w.prisma.systemSetting.deleteMany({ where: { organizationId: w.orgId } });
  });
});
