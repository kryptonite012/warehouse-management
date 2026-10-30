#!/usr/bin/env node
/**
 * End-to-end walkthrough against a running API (all data created is prefixed DEMO).
 * Exercises: procurement -> receiving -> QC -> storefront -> order -> pick -> pack
 * -> dispatch -> OTP delivery, then prints the resulting ledger and KPIs.
 *
 *   API=http://localhost:3000/api/v1 ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/demo-walkthrough.mjs
 */
import { randomUUID } from 'node:crypto';

const API = process.env.API ?? 'http://localhost:3000/api/v1';
const PW = 'Demo#Passw0rd1';

async function call(token, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json?.error ?? json)}`);
  return json;
}
const login = async (identifier, password) => (await call(null, 'POST', '/auth/login', { identifier, password })).accessToken;
const step = (s) => console.log(`\n▸ ${s}`);

const admin = await login(process.env.ADMIN_EMAIL ?? 'admin@quickstore.local', process.env.ADMIN_PASSWORD ?? 'Admin#Passw0rd!');
const sites = (await call(admin, 'GET', '/warehouses?pageSize=50')).data;
const cw = sites.find((s) => s.code === 'DEMO-CW1');
const ds = sites.find((s) => s.code === 'DEMO-DS1');
if (!cw || !ds) throw new Error('Run the seed with SEED_DEMO=true first');

step('Staff accounts (scoped to the demo dark store)');
const tag = randomUUID().slice(0, 6);
const mk = async (role, name) => {
  const email = `demo.${role.toLowerCase()}.${tag}@quickstore.local`;
  const u = await call(admin, 'POST', '/users', { fullName: `DEMO ${name}`, email, password: PW, roles: [role], scopes: [{ scopeType: 'WAREHOUSE', scopeId: ds.id }] });
  return { id: u.id, token: await login(email, PW) };
};
const picker = await mk('PICKER', 'Picker');
const packer = await mk('PACKER', 'Packer');
const riderUser = await mk('DELIVERY_PARTNER', 'Rider');
const buyerEmail = `demo.buyer.${tag}@quickstore.local`;
await call(admin, 'POST', '/users', { fullName: 'DEMO Buyer', email: buyerEmail, password: PW, roles: ['PROCUREMENT_MANAGER'] });
const buyer = await login(buyerEmail, PW);
console.log('  picker, packer, rider, buyer created');

step('Warehouse layout + bin assignment');
const layout = await call(admin, 'GET', `/warehouses/${ds.id}/layout`);
if (!layout.tree.length) {
  await call(admin, 'POST', `/warehouses/${ds.id}/layout/generate`, { zoneCode: 'A', aisles: 2, racksPerAisle: 3, shelvesPerRack: 2, binsPerShelf: 2, binCapacityUnits: 60, temperatureZone: 'AMBIENT' });
  await call(admin, 'POST', `/warehouses/${ds.id}/layout/generate`, { zoneCode: 'C', aisles: 1, racksPerAisle: 2, shelvesPerRack: 2, binsPerShelf: 2, binCapacityUnits: 40, temperatureZone: 'CHILLED' });
}
const tree = (await call(admin, 'GET', `/warehouses/${ds.id}/layout`)).tree;
const bins = (zone) => tree.find((z) => z.code === zone).children.flatMap((a) => a.children.flatMap((r) => r.children.flatMap((s) => s.children)));
const products = (await call(admin, 'GET', '/products?search=DEMO&pageSize=50')).data;
let ai = 0, ci = 0;
for (const p of products) {
  const bin = p.storageCondition === 'CHILLED' ? bins('C')[ci++] : bins('A')[ai++];
  await call(admin, 'POST', `/warehouses/${ds.id}/sku-locations`, { skuId: p.skus[0].id, locationId: bin.id });
}
console.log(`  ${products.length} SKUs slotted into temperature-compatible bins`);

step('Procurement: PO -> approval -> partial receipt -> QC');
const supplier = (await call(admin, 'GET', '/suppliers?search=DEMO')).data[0];
const milk = products.find((p) => p.name.includes('Milk')).skus[0];
const po = await call(buyer, 'POST', '/purchase-orders', { supplierId: supplier.id, warehouseId: cw.id, items: [{ skuId: milk.id, orderedQty: 200, unitCost: 24 }] });
await call(buyer, 'POST', `/purchase-orders/${po.id}/submit`);
await call(admin, 'POST', `/purchase-orders/${po.id}/approve`);
const expires = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const grn = await call(admin, 'POST', '/goods-receipts', { purchaseOrderId: po.id, idempotencyKey: randomUUID(), items: [{ skuId: milk.id, batchNumber: `DEMO-L${tag}`, expiresAt: expires, receivedQty: 150 }] });
await call(admin, 'POST', `/goods-receipts/${grn.id}/inspect`, { lines: [{ itemId: grn.items[0].id, acceptedQty: 146, damagedQty: 4, rejectedQty: 0 }] });
await call(admin, 'POST', `/goods-receipts/${grn.id}/complete`);
const poAfter = await call(admin, 'GET', `/purchase-orders/${po.id}`);
console.log(`  ${po.poNumber}: ordered 200, received ${poAfter.items[0].receivedQty}, accepted ${poAfter.items[0].acceptedQty}, pending ${poAfter.items[0].pendingQty} (${poAfter.status})`);

step('Replenish dark store from central warehouse');
const t = await call(admin, 'POST', '/inventory/transfers', { fromWarehouseId: cw.id, toWarehouseId: ds.id, items: [{ skuId: milk.id, quantity: 30 }] });
await call(admin, 'POST', `/inventory/transfers/${t.id}/dispatch`);
await call(admin, 'POST', `/inventory/transfers/${t.id}/receive`, { lines: [{ itemId: t.items[0].id, receivedQty: 30 }] });
console.log(`  ${t.transferNumber} received`);

step('Rider on shift');
const rider = await call(admin, 'POST', '/delivery-partners', { homeStoreId: ds.id, fullName: 'DEMO Rider', phone: `9${Date.now() % 1e9}`.padEnd(10, '0'), vehicleType: 'EV_SCOOTER', userId: riderUser.id });
await call(admin, 'PATCH', `/delivery-partners/${rider.id}/availability`, { status: 'AVAILABLE' });

step('Customer orders from the storefront (real availability)');
const cust = await call(null, 'POST', '/customers/register', { fullName: 'DEMO Customer', phone: `8${String(Date.now()).slice(-9)}`, password: PW });
const ct = cust.accessToken;
const addr = await call(ct, 'POST', '/customers/addresses', { line1: '100 Feet Road', city: 'Bengaluru', state: 'KA', postalCode: '560038', latitude: 12.9716, longitude: 77.6408 });
const svc = await call(null, 'GET', '/storefront/serviceability?postalCode=560038');
const catalog = await call(null, 'GET', `/storefront/stores/${svc.stores[0].id}/products`);
const basket = catalog.data.filter((p) => p.inStock).slice(0, 3).map((p) => ({ skuId: p.variants[0].skuId, quantity: 2 }));
const order = await call(ct, 'POST', '/orders', { addressId: addr.id, items: basket, paymentMethod: 'COD', idempotencyKey: randomUUID() });
console.log(`  ${order.orderNumber} ${order.status}, total ₹${order.total}`);

step('Pick (barcode verified, FEFO batches, routed by bin sequence)');
const task = await call(picker.token, 'POST', '/picking-tasks', { orderId: order.id });
await call(picker.token, 'POST', `/picking-tasks/${task.id}/claim`);
const full = await call(picker.token, 'GET', `/picking-tasks/${task.id}`);
for (const item of full.items) {
  await call(picker.token, 'POST', `/picking-tasks/${task.id}/scan`, { itemId: item.id, barcode: item.sku.barcode, quantity: item.quantity });
  console.log(`  ${item.locationCode ?? '—'}  ${item.sku.name} x${item.quantity} (batch ${item.batch.number})`);
}
await call(picker.token, 'POST', `/picking-tasks/${task.id}/complete`, {});

step('Pack, label and dispatch');
const pack = (await call(packer.token, 'GET', `/packing-tasks?warehouseId=${ds.id}&status=PENDING`)).find((p) => p.orderId === order.id);
const o2 = await call(admin, 'GET', `/orders/${order.id}`);
await call(packer.token, 'POST', `/packing-tasks/${pack.id}/complete`, { packagingType: 'COLD_BAG', lines: o2.items.map((i) => ({ orderItemId: i.id, quantity: i.pickedQty })) });
const assignment = await call(admin, 'POST', '/deliveries/assign', { orderId: order.id });

step('Rider delivers with the customer OTP');
await call(riderUser.token, 'POST', `/deliveries/${assignment.id}/status`, { status: 'ACCEPTED' });
await call(riderUser.token, 'POST', `/deliveries/${assignment.id}/status`, { status: 'PICKED_UP' });
const otp = (await call(ct, 'GET', `/orders/${order.id}`)).deliveryOtp;
await call(riderUser.token, 'POST', `/deliveries/${assignment.id}/proof-of-delivery`, { method: 'OTP', otp });
const final = await call(ct, 'GET', `/orders/${order.id}`);
console.log(`  ${final.orderNumber}: ${final.statusHistory.map((h) => h.toStatus).join(' → ')}`);
console.log(`  payment: ${final.payments[0].status}`);

step('Live KPIs');
const kpi = await call(admin, 'GET', '/reports/overview');
console.log(`  orders today ${kpi.ordersToday.total}, delivered ${kpi.ordersToday.delivered}, inventory value ₹${Math.round(kpi.inventory.inventoryValuation)}, low-stock ${kpi.inventory.lowStockSkus}`);
console.log('\n✓ walkthrough complete');
