#!/usr/bin/env node
/**
 * Dependency-free load runner (Node 20+). Prepares data through the public API, then
 * drives each scenario with N concurrent virtual users for D seconds and reports
 * throughput, error rate and latency percentiles. Results are measurements of *your*
 * deployment — not guaranteed capacity figures.
 *
 *   API=https://admin.example/api/v1 ADMIN_EMAIL=… ADMIN_PASSWORD=… VUS=50 DURATION=20 node tests/load/run.mjs
 */
import { randomUUID } from 'node:crypto';

const API = process.env.API ?? 'http://localhost:3000/api/v1';
const VUS = Number(process.env.VUS ?? 25);
const DURATION = Number(process.env.DURATION ?? 15) * 1000;
const ONLY = process.env.SCENARIOS?.split(',');

async function call(token, method, path, body, extraHeaders = {}) {
  const t0 = performance.now();
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, ms: performance.now() - t0, body: text ? JSON.parse(text) : null };
}
const must = async (p) => {
  const r = await p;
  if (r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

function pct(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
}

async function scenario(name, fn, { expectStatus = (s) => s < 400 } = {}) {
  if (ONLY && !ONLY.includes(name)) return null;
  const lat = [];
  const codes = {};
  let errors = 0;
  const end = Date.now() + DURATION;
  await Promise.all(
    Array.from({ length: VUS }, async (_, vu) => {
      let i = 0;
      while (Date.now() < end) {
        try {
          const r = await fn(vu, i++);
          lat.push(r.ms);
          codes[r.status] = (codes[r.status] ?? 0) + 1;
          if (!expectStatus(r.status)) errors++;
        } catch {
          errors++;
        }
      }
    }),
  );
  lat.sort((a, b) => a - b);
  const row = {
    scenario: name, requests: lat.length, rps: +(lat.length / (DURATION / 1000)).toFixed(1),
    p50: +pct(lat, 50).toFixed(1), p95: +pct(lat, 95).toFixed(1), p99: +pct(lat, 99).toFixed(1),
    errorRate: +(errors / Math.max(lat.length, 1)).toFixed(4), statuses: JSON.stringify(codes),
  };
  console.log(row);
  return row;
}

// ------------------------------------------------------------------ setup
const admin = (await must(call(null, 'POST', '/auth/login', { identifier: process.env.ADMIN_EMAIL ?? 'admin@quickstore.local', password: process.env.ADMIN_PASSWORD ?? 'Admin#Passw0rd!' }))).accessToken;
const tag = randomUUID().slice(0, 6).toUpperCase();
const cat = await must(call(admin, 'POST', '/categories', { name: `LOAD ${tag}` }));
const store = await must(call(admin, 'POST', '/warehouses', {
  code: `LOAD-${tag}`, name: `LOAD TEST store ${tag}`, type: 'DARK_STORE', addressLine1: 'Load test', city: 'Bengaluru', state: 'KA',
  postalCode: '560099', latitude: 12.9, longitude: 77.6, darkStore: { servicePostalCodes: ['560099'], maxConcurrentOrders: 100000 },
}));
const skus = [];
for (let i = 0; i < 20; i++) {
  const p = await must(call(admin, 'POST', '/products', {
    name: `LOAD product ${tag} ${i}`, categoryId: cat.id, expiryTracked: false,
    skus: [{ code: `LOAD-${tag}-${i}`, mrp: 60, sellingPrice: 50, purchasePrice: 30, barcodes: [`LD${tag}${String(i).padStart(4, '0')}`] }],
  }));
  skus.push(p.skus[0]);
}
// Stock via the procurement path (PO -> GRN -> QC) so it goes through the ledger.
const sup = await must(call(admin, 'POST', '/suppliers', { code: `LS${tag}`, name: `LOAD supplier ${tag}` }));
const po = await must(call(admin, 'POST', '/purchase-orders', { supplierId: sup.id, warehouseId: store.id, items: skus.map((s) => ({ skuId: s.id, orderedQty: 100000, unitCost: 30 })) }));
await must(call(admin, 'POST', `/purchase-orders/${po.id}/submit`));
await must(call(admin, 'POST', `/purchase-orders/${po.id}/approve`));
const grn = await must(call(admin, 'POST', '/goods-receipts', { purchaseOrderId: po.id, idempotencyKey: randomUUID(), items: skus.map((s) => ({ skuId: s.id, batchNumber: 'LOAD', receivedQty: 100000 })) }));
await must(call(admin, 'POST', `/goods-receipts/${grn.id}/inspect`, { lines: grn.items.map((i) => ({ itemId: i.id, acceptedQty: i.receivedQty, rejectedQty: 0, damagedQty: 0 })) }));
// A hot SKU with very little stock for the contention scenario.
const hot = await must(call(admin, 'POST', '/products', { name: `LOAD hot ${tag}`, categoryId: cat.id, expiryTracked: false, skus: [{ code: `LOAD-${tag}-HOT`, mrp: 10, sellingPrice: 10, purchasePrice: 5 }] }));
const po2 = await must(call(admin, 'POST', '/purchase-orders', { supplierId: sup.id, warehouseId: store.id, items: [{ skuId: hot.skus[0].id, orderedQty: 50, unitCost: 5 }] }));
await must(call(admin, 'POST', `/purchase-orders/${po2.id}/submit`));
await must(call(admin, 'POST', `/purchase-orders/${po2.id}/approve`));
const grn2 = await must(call(admin, 'POST', '/goods-receipts', { purchaseOrderId: po2.id, idempotencyKey: randomUUID(), items: [{ skuId: hot.skus[0].id, batchNumber: 'HOT', receivedQty: 50 }] }));
await must(call(admin, 'POST', `/goods-receipts/${grn2.id}/inspect`, { lines: [{ itemId: grn2.items[0].id, acceptedQty: 50, rejectedQty: 0, damagedQty: 0 }] }));

const customers = [];
for (let i = 0; i < Math.min(VUS, 50); i++) {
  const c = await must(call(null, 'POST', '/customers/register', { fullName: `LOAD ${i}`, phone: `5${String(Date.now()).slice(-6)}${String(i).padStart(3, '0')}`, password: 'LoadTest#Pass1' }));
  const a = await must(call(c.accessToken, 'POST', '/customers/addresses', { line1: 'Load lane', city: 'Bengaluru', state: 'KA', postalCode: '560099' }));
  customers.push({ token: c.accessToken, addressId: a.id });
}
const device = await must(call(admin, 'POST', '/sync/devices', { warehouseId: store.id, name: 'load agent', allowedOps: ['DAMAGE_REPORT'] }));
const me = await must(call(admin, 'GET', '/auth/me'));
const batch = (await must(call(admin, 'GET', `/inventory/${skus[0].id}?warehouseId=${store.id}`))).batches[0];
console.log(`setup done: store ${store.code}, ${skus.length} SKUs, ${customers.length} customers, VUS=${VUS}, ${DURATION / 1000}s per scenario\n`);

// ------------------------------------------------------------------ scenarios
const results = [];
results.push(await scenario('product_search', (vu, i) => call(null, 'GET', `/storefront/stores/${store.id}/products?search=LOAD%20product&page=${(i % 3) + 1}`)));
results.push(await scenario('warehouse_scanning', (vu, i) => call(admin, 'GET', `/barcodes/LD${tag}${String((vu + i) % 20).padStart(4, '0')}`)));
results.push(await scenario('inventory_reservations', (vu, i) =>
  call(admin, 'POST', '/inventory/reservations', { warehouseId: store.id, items: [{ skuId: skus[(vu + i) % 20].id, quantity: 1 }], idempotencyKey: randomUUID(), ttlMinutes: 1 })));
results.push(await scenario('hot_sku_contention', () =>
  call(admin, 'POST', '/inventory/reservations', { warehouseId: store.id, items: [{ skuId: hot.skus[0].id, quantity: 1 }], idempotencyKey: randomUUID(), ttlMinutes: 60 }),
  { expectStatus: (s) => s === 201 || s === 409 }));
results.push(await scenario('concurrent_orders', (vu) => {
  const c = customers[vu % customers.length];
  return call(c.token, 'POST', '/orders', { addressId: c.addressId, items: [{ skuId: skus[vu % 20].id, quantity: 1 }, { skuId: skus[(vu + 7) % 20].id, quantity: 2 }], paymentMethod: 'COD', idempotencyKey: randomUUID() });
}));
results.push(await scenario('stock_sync', (vu, i) =>
  call(null, 'POST', '/sync/push', { operations: [{ clientOpId: randomUUID(), sequence: vu * 1e6 + i + 1, opType: 'DAMAGE_REPORT', occurredAt: new Date().toISOString(), performedBy: me.id, payload: { batchId: batch.id, quantity: 1, reason: 'load' } }] },
    { 'x-device-token': device.token })));
results.push(await scenario('dashboard_analytics', () => call(admin, 'GET', '/reports/overview')));

// Correctness check after contention: exactly 50 hot units reserved, never more.
const hotStock = (await must(call(admin, 'GET', `/inventory?warehouseId=${store.id}&search=HOT`))).data[0];
console.log(`\nhot SKU after contention: available=${hotStock.available} reserved=${hotStock.reserved} (stock was 50)`);
if (hotStock.reserved > 50 || hotStock.available < 0) {
  console.error('OVERSELL DETECTED');
  process.exit(1);
}
console.table(results.filter(Boolean));
