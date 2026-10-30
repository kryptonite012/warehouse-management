// k6 run -e API=https://shop.example/api/v1 -e STORE=<storeId> -e TOKEN=<customer token> -e ADDRESS=<addressId> -e SKU=<skuId> tests/load/k6/checkout.js
import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  scenarios: {
    browse: { executor: 'constant-arrival-rate', rate: 200, timeUnit: '1s', duration: '5m', preAllocatedVUs: 100, exec: 'browse' },
    checkout: { executor: 'ramping-arrival-rate', startRate: 5, timeUnit: '1s', stages: [{ target: 50, duration: '2m' }, { target: 50, duration: '3m' }], preAllocatedVUs: 200, exec: 'checkout' },
  },
  thresholds: {
    'http_req_duration{scenario:browse}': ['p(95)<300'],
    'http_req_duration{scenario:checkout}': ['p(95)<800'],
    http_req_failed: ['rate<0.01'],
  },
};

const API = __ENV.API;
export function browse() {
  const r = http.get(`${API}/storefront/stores/${__ENV.STORE}/products?search=milk`);
  check(r, { 'browse 200': (x) => x.status === 200 });
}
export function checkout() {
  const r = http.post(`${API}/orders`, JSON.stringify({
    addressId: __ENV.ADDRESS, items: [{ skuId: __ENV.SKU, quantity: 1 }], paymentMethod: 'COD', idempotencyKey: uuidv4(),
  }), { headers: { 'content-type': 'application/json', authorization: `Bearer ${__ENV.TOKEN}` } });
  check(r, { 'order accepted or out of stock': (x) => x.status === 201 || x.status === 409 });
}
