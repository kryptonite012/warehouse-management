import { createHmac, randomUUID } from 'crypto';
import { closeWorld, createWorld, employee, key, PASSWORD, sku, stock, warehouse, World } from './helpers';

describe('Commerce: orders, state machine and payments', () => {
  let w: World;
  let orgCode: string;
  beforeAll(async () => {
    w = await createWorld();
    orgCode = (await w.prisma.organization.findUniqueOrThrow({ where: { id: w.orgId } })).code;
  });
  afterAll(async () => closeWorld(w));

  async function customer() {
    const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
    const reg = await w.http().post('/api/v1/customers/register').send({ organizationCode: orgCode, fullName: 'Asha', phone, password: PASSWORD }).expect(201);
    const token = reg.body.accessToken;
    const call = (m: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string) => w.http()[m](`/api/v1${url}`).set('Authorization', `Bearer ${token}`);
    const addr = await call('post', '/customers/addresses').send({ line1: '12 MG Road', city: 'Bengaluru', state: 'KA', postalCode: '560038' }).expect(201);
    return { call, addressId: addr.body.id as string };
  }

  const sign = (body: object) => {
    const raw = JSON.stringify(body);
    return { raw, sig: createHmac('sha256', process.env.PAYMENT_WEBHOOK_SECRET!).update(raw).digest('hex') };
  };
  const webhook = (body: object, sig?: string) => {
    const s = sign(body);
    return w.http().post('/api/v1/payments/webhooks/generic-hmac').set('Content-Type', 'application/json').set('x-signature', sig ?? s.sig).send(s.raw);
  };

  it('storefront shows real availability and COD order reserves stock atomically', async () => {
    const store = await warehouse(w);
    const s = await sku(w, { price: 40 });
    await stock(w, store.id, s.id, 3);
    const c = await customer();

    const svc = await w.http().get(`/api/v1/storefront/serviceability?postalCode=560038&org=${orgCode}`).expect(200);
    expect(svc.body.serviceable).toBe(true);
    expect(svc.body.etaMinutes).toBeNull(); // no fabricated ETA
    const list = await w.http().get(`/api/v1/storefront/stores/${store.id}/products?search=${encodeURIComponent(s.code.slice(4))}&org=${orgCode}`);
    expect(list.status).toBe(200);

    const order = await c.call('post', '/orders').send({ addressId: c.addressId, items: [{ skuId: s.id, quantity: 2 }], paymentMethod: 'COD', idempotencyKey: key() }).expect(201);
    expect(order.body.status).toBe('ACCEPTED');
    expect(Number(order.body.subtotal)).toBe(80);
    expect(order.body.statusHistory.map((h: any) => h.toStatus)).toEqual(['CREATED', 'INVENTORY_RESERVED', 'ACCEPTED']);
    const bal = await w.prisma.inventoryBalance.findFirstOrThrow({ where: { warehouseId: store.id, skuId: s.id } });
    expect(bal).toMatchObject({ available: 1, reserved: 2 });
  });

  it('order creation is idempotent across concurrent network retries', async () => {
    const store = await warehouse(w);
    const s = await sku(w);
    await stock(w, store.id, s.id, 10);
    const c = await customer();
    const body = { addressId: c.addressId, items: [{ skuId: s.id, quantity: 1 }], paymentMethod: 'COD', idempotencyKey: key() };
    const results = await Promise.all(Array.from({ length: 5 }, () => c.call('post', '/orders').send(body)));
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(await w.prisma.order.count({ where: { idempotencyKey: body.idempotencyKey } })).toBe(1);
    const bal = await w.prisma.inventoryBalance.findFirstOrThrow({ where: { warehouseId: store.id, skuId: s.id } });
    expect(bal.reserved).toBe(1);
  });

  it('TEST 2 (order level): cancellation releases the reservation exactly once', async () => {
    const store = await warehouse(w);
    const s = await sku(w);
    await stock(w, store.id, s.id, 4);
    const c = await customer();
    const o = await c.call('post', '/orders').send({ addressId: c.addressId, items: [{ skuId: s.id, quantity: 4 }], paymentMethod: 'COD', idempotencyKey: key() }).expect(201);
    const cancels = await Promise.all(Array.from({ length: 4 }, () => c.call('post', `/orders/${o.body.id}/cancel`).send({ reason: 'changed my mind' })));
    expect(cancels.filter((r) => r.status === 201)).toHaveLength(1);
    expect(cancels.filter((r) => r.status === 409)).toHaveLength(3);
    const bal = await w.prisma.inventoryBalance.findFirstOrThrow({ where: { warehouseId: store.id, skuId: s.id } });
    expect(bal).toMatchObject({ available: 4, reserved: 0 });
    expect(await w.prisma.inventoryMovement.count({ where: { referenceId: o.body.reservationId, movementType: 'RELEASE' } })).toBe(1);
  });

  it('TEST 8: duplicate payment callbacks are processed exactly once; forged ones are rejected', async () => {
    const store = await warehouse(w);
    const s = await sku(w, { price: 100 });
    await stock(w, store.id, s.id, 5);
    const c = await customer();
    const o = await c.call('post', '/orders').send({ addressId: c.addressId, items: [{ skuId: s.id, quantity: 1 }], paymentMethod: 'UPI', idempotencyKey: key() }).expect(201);
    expect(o.body.status).toBe('PAYMENT_PENDING');
    const payment = o.body.payments[0];

    const event = { eventId: `evt_${randomUUID()}`, type: 'payment.captured', paymentId: payment.id, providerPaymentId: 'pay_123', amount: Number(payment.amount) };
    await webhook(event, 'f'.repeat(64)).expect(401);
    const results = await Promise.all(Array.from({ length: 5 }, () => webhook(event)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.status === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r.body.status === 'duplicate')).toHaveLength(4);

    const order = await c.call('get', `/orders/${o.body.id}`).expect(200);
    expect(order.body.status).toBe('ACCEPTED');
    expect(order.body.payments[0].status).toBe('CAPTURED');
    expect(order.body.statusHistory.filter((h: any) => h.toStatus === 'PAYMENT_CONFIRMED')).toHaveLength(1);

    // A tampered amount is rejected even with a valid signature.
    const o2 = await c.call('post', '/orders').send({ addressId: c.addressId, items: [{ skuId: s.id, quantity: 1 }], paymentMethod: 'UPI', idempotencyKey: key() }).expect(201);
    await webhook({ eventId: `evt_${randomUUID()}`, type: 'payment.captured', paymentId: o2.body.payments[0].id, amount: 1 }).expect(422);
  });

  it('rejects invalid state transitions and blocks customers from other customers orders', async () => {
    const store = await warehouse(w);
    const s = await sku(w);
    await stock(w, store.id, s.id, 5);
    const c1 = await customer();
    const c2 = await customer();
    const o = await c1.call('post', '/orders').send({ addressId: c1.addressId, items: [{ skuId: s.id, quantity: 1 }], paymentMethod: 'COD', idempotencyKey: key() }).expect(201);
    await c2.call('get', `/orders/${o.body.id}`).expect(404);
    await c1.call('post', `/orders/${o.body.id}/return-request`).send({ reason: 'not delivered yet' }).expect(409);
    // Customers cannot hit staff endpoints at all.
    await c1.call('get', '/inventory').expect(403);
  });

  it('refuses online payment when no gateway is configured (no simulated success)', async () => {
    const { PaymentGateway } = await import('../src/modules/payments/gateway');
    const gw = w.app.get(PaymentGateway);
    const saved = gw.provider;
    (gw as any).provider = null;
    try {
      const store = await warehouse(w);
      const s = await sku(w);
      await stock(w, store.id, s.id, 5);
      const c = await customer();
      const r = await c.call('post', '/orders').send({ addressId: c.addressId, items: [{ skuId: s.id, quantity: 1 }], paymentMethod: 'CARD', idempotencyKey: key() });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('PAYMENT_NOT_CONFIGURED');
    } finally {
      (gw as any).provider = saved;
    }
  });

  it('staff without orders.read cannot list orders', async () => {
    const picker = await employee(w, ['PICKER']);
    await picker.call('get', '/orders').expect(403);
  });
});

describe('Transactional outbox', () => {
  let w: World;
  beforeAll(async () => { w = await createWorld(); });
  afterAll(async () => closeWorld(w));

  it('writes one event per committed order transition and none for rolled-back ones', async () => {
    const orgCode = (await w.prisma.organization.findUniqueOrThrow({ where: { id: w.orgId } })).code;
    const store = await warehouse(w);
    const s = await sku(w);
    await stock(w, store.id, s.id, 1);
    const reg = await w.http().post('/api/v1/customers/register').send({ organizationCode: orgCode, fullName: 'Ox', phone: `6${Date.now() % 1e9}`.padEnd(10, '1'), password: PASSWORD }).expect(201);
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    const addr = await w.http().post('/api/v1/customers/addresses').set(auth).send({ line1: 'x road', city: 'B', state: 'KA', postalCode: '560038' }).expect(201);
    const ok = await w.http().post('/api/v1/orders').set(auth).send({ addressId: addr.body.id, items: [{ skuId: s.id, quantity: 1 }], paymentMethod: 'COD', idempotencyKey: key() }).expect(201);
    // This one fails on stock -> the whole transaction, including its outbox rows, rolls back.
    await w.http().post('/api/v1/orders').set(auth).send({ addressId: addr.body.id, items: [{ skuId: s.id, quantity: 1 }], paymentMethod: 'COD', idempotencyKey: key() }).expect(409);
    const events = await w.prisma.outboxEvent.findMany({ where: { aggregateId: ok.body.id }, orderBy: { id: 'asc' } });
    expect(events.map((e) => e.topic)).toEqual(['order.created', 'order.inventory_reserved', 'order.accepted']);
    expect(await w.prisma.outboxEvent.count({ where: { topic: 'order.created', aggregateId: { not: ok.body.id }, payload: { path: ['darkStoreId'], equals: store.id } } })).toBe(0);
  });
});
