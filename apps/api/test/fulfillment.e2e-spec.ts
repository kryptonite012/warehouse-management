import { closeWorld, createWorld, employee, key, PASSWORD, sku, stock, warehouse, World } from './helpers';

describe('Fulfilment lifecycle: pick -> pack -> dispatch -> deliver -> return', () => {
  let w: World;
  let orgCode: string;
  beforeAll(async () => {
    w = await createWorld();
    orgCode = (await w.prisma.organization.findUniqueOrThrow({ where: { id: w.orgId } })).code;
  });
  afterAll(async () => closeWorld(w));

  async function customer() {
    const phone = `8${Math.floor(100000000 + Math.random() * 899999999)}`;
    const reg = await w.http().post('/api/v1/customers/register').send({ organizationCode: orgCode, fullName: 'Ravi', phone, password: PASSWORD }).expect(201);
    const call = (m: 'get' | 'post', url: string) => w.http()[m](`/api/v1${url}`).set('Authorization', `Bearer ${reg.body.accessToken}`);
    const addr = await call('post', '/customers/addresses').send({ line1: '5 Church St', city: 'Bengaluru', state: 'KA', postalCode: '560038' }).expect(201);
    return { call, addressId: addr.body.id };
  }

  async function setup() {
    const store = await warehouse(w);
    const picker = await employee(w, ['PICKER'], { warehouseIds: [store.id] });
    const packer = await employee(w, ['PACKER'], { warehouseIds: [store.id] });
    const dispatcher = await employee(w, ['DISPATCH_MANAGER'], { warehouseIds: [store.id] });
    const riderUser = await employee(w, ['DELIVERY_PARTNER']);
    const manager = await employee(w, ['DARK_STORE_MANAGER'], { warehouseIds: [store.id] });
    const rider = await dispatcher.call('post', '/delivery-partners').send({ homeStoreId: store.id, fullName: 'Rider One', phone: `7${Date.now() % 1_000_000_000}`, vehicleType: 'EV_SCOOTER', userId: riderUser.user.id }).expect(201);
    await dispatcher.call('patch', `/delivery-partners/${rider.body.id}/availability`).send({ status: 'AVAILABLE' }).expect(200);
    return { store, picker, packer, dispatcher, riderUser, manager, rider: rider.body };
  }

  it('runs the full order lifecycle with barcode verification and OTP proof of delivery', async () => {
    const { store, picker, packer, dispatcher, riderUser, manager } = await setup();
    const s = await sku(w, { price: 30 });
    await stock(w, store.id, s.id, 10);
    const c = await customer();
    const order = (await c.call('post', '/orders').send({ addressId: c.addressId, items: [{ skuId: s.id, quantity: 3 }], paymentMethod: 'COD', idempotencyKey: key() }).expect(201)).body;

    const task = (await picker.call('post', '/picking-tasks').send({ orderId: order.id }).expect(201)).body;
    await picker.call('post', `/picking-tasks/${task.id}/claim`).expect(201);
    const item = task.items[0];
    await picker.call('post', `/picking-tasks/${task.id}/scan`).send({ itemId: item.id, barcode: 'WRONG-BARCODE', quantity: 1 }).expect(422);
    await picker.call('post', `/picking-tasks/${task.id}/scan`).send({ itemId: item.id, barcode: s.barcodes[0].barcode, quantity: 3 }).expect(201);
    await picker.call('post', `/picking-tasks/${task.id}/complete`).send({}).expect(201);

    let bal = await w.prisma.inventoryBalance.findFirstOrThrow({ where: { warehouseId: store.id, skuId: s.id } });
    expect(bal).toMatchObject({ onHand: 7, available: 7, reserved: 0 }); // picked units left the ledger

    const packTask = (await packer.call('get', `/packing-tasks?warehouseId=${store.id}&status=PENDING`).expect(200)).body.find((p: any) => p.orderId === order.id);
    await packer.call('post', `/packing-tasks/${packTask.id}/complete`).send({ packagingType: 'BAG_SMALL', lines: [{ orderItemId: order.items[0].id, quantity: 2 }] }).expect(422);
    await packer.call('post', `/packing-tasks/${packTask.id}/complete`).send({ packagingType: 'BAG_SMALL', lines: [{ orderItemId: order.items[0].id, quantity: 3 }] }).expect(201);

    const assignment = (await dispatcher.call('post', '/deliveries/assign').send({ orderId: order.id }).expect(201)).body;
    const mine = await riderUser.call('get', '/deliveries').expect(200);
    expect(mine.body.map((d: any) => d.id)).toContain(assignment.id);
    await riderUser.call('post', `/deliveries/${assignment.id}/status`).send({ status: 'ACCEPTED' }).expect(201);
    await riderUser.call('post', `/deliveries/${assignment.id}/status`).send({ status: 'PICKED_UP' }).expect(201);

    // Staff/rider views never expose the OTP; the customer's view does.
    const staffView = await manager.call('get', `/orders/${order.id}`).expect(200);
    expect(staffView.body.deliveryOtp).toBeNull();
    const custView = await c.call('get', `/orders/${order.id}`).expect(200);
    expect(custView.body.deliveryOtp).toMatch(/^\d{4}$/);
    expect(custView.body.delivery.events.every((e: any) => e.latitude === null)).toBe(true); // no fabricated GPS

    const wrong = custView.body.deliveryOtp === '0000' ? '1111' : '0000';
    await riderUser.call('post', `/deliveries/${assignment.id}/proof-of-delivery`).send({ method: 'OTP', otp: wrong }).expect(422);
    await riderUser.call('post', `/deliveries/${assignment.id}/proof-of-delivery`).send({ method: 'OTP', otp: custView.body.deliveryOtp }).expect(201);

    const done = await c.call('get', `/orders/${order.id}`).expect(200);
    expect(done.body.status).toBe('DELIVERED');
    expect(done.body.payments[0].status).toBe('COD_COLLECTED');
    expect(done.body.statusHistory.map((h: any) => h.toStatus)).toEqual([
      'CREATED', 'INVENTORY_RESERVED', 'ACCEPTED', 'PICKING', 'PICKED', 'PACKING', 'PACKED', 'READY_FOR_DISPATCH', 'RIDER_ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED',
    ]);

    // Return: 2 resalable go back to stock, 1 damaged.
    await c.call('post', `/orders/${order.id}/return-request`).send({ reason: 'ordered too many' }).expect(201);
    await manager.call('post', `/orders/${order.id}/returns/receive`).send({
      lines: [{ orderItemId: order.items[0].id, quantity: 2, condition: 'RESALABLE' }],
    }).expect(201);
    bal = await w.prisma.inventoryBalance.findFirstOrThrow({ where: { warehouseId: store.id, skuId: s.id } });
    expect(bal.available).toBe(9);
    const refunded = await c.call('get', `/orders/${order.id}`).expect(200);
    expect(refunded.body.status).toBe('REFUND_PENDING');
    expect(Number(refunded.body.payments[0].refunds[0].amount)).toBe(60);
  });

  it('TEST 5 (pick time): a batch that expired after reservation cannot be picked', async () => {
    const { store, picker } = await setup();
    const s = await sku(w);
    const batch = await stock(w, store.id, s.id, 5, { expiresInDays: 1 });
    const c = await customer();
    const order = (await c.call('post', '/orders').send({ addressId: c.addressId, items: [{ skuId: s.id, quantity: 1 }], paymentMethod: 'COD', idempotencyKey: key() }).expect(201)).body;
    const task = (await picker.call('post', '/picking-tasks').send({ orderId: order.id }).expect(201)).body;
    await picker.call('post', `/picking-tasks/${task.id}/claim`).expect(201);
    await w.prisma.inventoryBatch.update({ where: { id: batch.id }, data: { expiresAt: new Date(Date.now() - 86_400_000) } });
    const r = await picker.call('post', `/picking-tasks/${task.id}/scan`).send({ itemId: task.items[0].id, barcode: s.barcodes[0].barcode, quantity: 1 });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('BATCH_EXPIRED');
  });

  it('short pick releases unpicked units and marks the order partially fulfilled', async () => {
    const { store, picker } = await setup();
    const s = await sku(w);
    await stock(w, store.id, s.id, 5);
    const c = await customer();
    const order = (await c.call('post', '/orders').send({ addressId: c.addressId, items: [{ skuId: s.id, quantity: 4 }], paymentMethod: 'COD', idempotencyKey: key() }).expect(201)).body;
    const task = (await picker.call('post', '/picking-tasks').send({ orderId: order.id }).expect(201)).body;
    await picker.call('post', `/picking-tasks/${task.id}/claim`).expect(201);
    await picker.call('post', `/picking-tasks/${task.id}/scan`).send({ itemId: task.items[0].id, barcode: s.barcodes[0].barcode, quantity: 3 }).expect(201);
    const done = await picker.call('post', `/picking-tasks/${task.id}/complete`).send({}).expect(201);
    expect(done.body.short).toBe(true);
    const bal = await w.prisma.inventoryBalance.findFirstOrThrow({ where: { warehouseId: store.id, skuId: s.id } });
    expect(bal).toMatchObject({ onHand: 2, available: 2, reserved: 0 });
    const o = await w.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.status).toBe('PARTIALLY_FULFILLED');
  });

  it('a picker cannot dispatch, and pickers from another store cannot see tasks', async () => {
    const { store, picker } = await setup();
    const other = await warehouse(w);
    const outsider = await employee(w, ['PICKER'], { warehouseIds: [other.id] });
    await picker.call('post', '/deliveries/assign').send({ orderId: '00000000-0000-4000-8000-000000000000' }).expect(403);
    await outsider.call('get', `/picking-tasks?warehouseId=${store.id}`).expect(403);
  });
});
