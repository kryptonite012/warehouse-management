# API reference

Base URL: `/api/v1` · Interactive docs: `/api/docs` (Swagger UI) · Machine-readable: [`openapi.json`](openapi.json)

## Conventions

* **Auth**: `Authorization: Bearer <access token>` (15 min). Employees refresh with `POST /auth/refresh` (single-use refresh tokens; reuse revokes the session family). Customers use `/customers/login`. Edge agents send `x-device-token`.
* **Errors**: every error has the same envelope:

```json
{ "statusCode": 409, "error": { "code": "INSUFFICIENT_STOCK", "message": "…", "details": { }, "requestId": "…" } }
```

  Common codes: `VALIDATION_FAILED` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `STALE_VERSION` / `INVALID_*_TRANSITION` / `INSUFFICIENT_STOCK` (409), domain rule codes (422), `RATE_LIMITED` (429), `ACCOUNT_LOCKED` (423).
* **Pagination**: `?page=1&pageSize=25&sortBy=createdAt&sortDir=desc&search=…` → `{ data: [...], meta: { page, pageSize, total, totalPages } }`.
* **Idempotency**: state-creating operations that may be retried take an `idempotencyKey` in the body (orders, reservations, goods receipts, QC status changes). Replays return the original result (orders reply `200` + `Idempotent-Replayed: true`).
* **Concurrency**: `PATCH` on editable records requires the current `version`; stale writes get `409 STALE_VERSION`.
* **Request IDs**: send `x-request-id` or one is generated; it is echoed back and stored on audit rows.

## Endpoints

### auth

| Method | Path |
| --- | --- |
| `POST` | `/auth/forgot-password` |
| `POST` | `/auth/login` |
| `POST` | `/auth/logout` |
| `GET` | `/auth/me` |
| `POST` | `/auth/refresh` |
| `POST` | `/auth/reset-password` |
| `GET` | `/auth/sessions` |
| `DELETE` | `/auth/sessions/{id}` |

### customers

| Method | Path |
| --- | --- |
| `GET` | `/customers` |
| `POST` | `/customers/addresses` |
| `DELETE` | `/customers/addresses/{id}` |
| `PUT` | `/customers/addresses/{id}` |
| `POST` | `/customers/login` |
| `GET` | `/customers/profile` |
| `PATCH` | `/customers/profile` |
| `POST` | `/customers/register` |

### delivery

| Method | Path |
| --- | --- |
| `GET` | `/deliveries` |
| `POST` | `/deliveries/assign` |
| `GET` | `/deliveries/{id}` |
| `POST` | `/deliveries/{id}/proof-of-delivery` |
| `POST` | `/deliveries/{id}/status` |
| `GET` | `/delivery-partners` |
| `POST` | `/delivery-partners` |
| `PATCH` | `/delivery-partners/{id}/availability` |
| `GET` | `/delivery-partners/{id}/performance` |
| `POST` | `/delivery-partners/{id}/shifts` |

### fulfillment

| Method | Path |
| --- | --- |
| `GET` | `/packing-tasks` |
| `POST` | `/packing-tasks` |
| `POST` | `/packing-tasks/{id}/complete` |
| `GET` | `/packing-tasks/{id}/label` |
| `GET` | `/picking-tasks` |
| `POST` | `/picking-tasks` |
| `GET` | `/picking-tasks/{id}` |
| `POST` | `/picking-tasks/{id}/claim` |
| `POST` | `/picking-tasks/{id}/complete` |
| `POST` | `/picking-tasks/{id}/scan` |
| `POST` | `/picking-waves` |
| `GET` | `/picking-waves/{id}/route` |

### governance

| Method | Path |
| --- | --- |
| `GET` | `/audit-logs` |
| `GET` | `/notifications` |
| `POST` | `/notifications/{id}/read` |
| `GET` | `/security-events` |
| `GET` | `/settings` |
| `PUT` | `/settings` |

### intelligence

| Method | Path |
| --- | --- |
| `GET` | `/intelligence/anomalies/{warehouseId}` |
| `GET` | `/intelligence/forecasts` |
| `POST` | `/intelligence/forecasts/run` |
| `GET` | `/intelligence/replenishment` |
| `POST` | `/intelligence/replenishment/accept` |
| `POST` | `/intelligence/replenishment/run` |
| `GET` | `/intelligence/status` |

### inventory

| Method | Path |
| --- | --- |
| `GET` | `/inventory` |
| `GET` | `/inventory/adjustments` |
| `POST` | `/inventory/adjustments` |
| `POST` | `/inventory/adjustments/{id}/decision` |
| `GET` | `/inventory/counts` |
| `POST` | `/inventory/counts` |
| `GET` | `/inventory/counts/{id}` |
| `POST` | `/inventory/counts/{id}/reconcile` |
| `POST` | `/inventory/counts/{id}/submit` |
| `GET` | `/inventory/expiring` |
| `GET` | `/inventory/low-stock` |
| `GET` | `/inventory/movements` |
| `POST` | `/inventory/reservations` |
| `POST` | `/inventory/reservations/{id}/release` |
| `GET` | `/inventory/transfers` |
| `POST` | `/inventory/transfers` |
| `POST` | `/inventory/transfers/{id}/dispatch` |
| `POST` | `/inventory/transfers/{id}/receive` |
| `POST` | `/inventory/warehouses/{warehouseId}/status-changes` |
| `GET` | `/inventory/{skuId}` |

### orders

| Method | Path |
| --- | --- |
| `GET` | `/orders` |
| `POST` | `/orders` |
| `GET` | `/orders/{id}` |
| `POST` | `/orders/{id}/cancel` |
| `GET` | `/orders/{id}/history` |
| `POST` | `/orders/{id}/return-request` |
| `POST` | `/orders/{id}/returns/receive` |

### organization

| Method | Path |
| --- | --- |
| `GET` | `/organization` |
| `POST` | `/organization/business-units` |
| `POST` | `/organization/regions` |

### payments

| Method | Path |
| --- | --- |
| `GET` | `/payments` |
| `GET` | `/payments/config` |
| `GET` | `/payments/reconciliation` |
| `POST` | `/payments/refunds/{id}/complete` |
| `POST` | `/payments/webhooks/{provider}` |

### procurement

| Method | Path |
| --- | --- |
| `GET` | `/goods-receipts` |
| `POST` | `/goods-receipts` |
| `GET` | `/goods-receipts/{id}` |
| `POST` | `/goods-receipts/{id}/complete` |
| `POST` | `/goods-receipts/{id}/inspect` |
| `GET` | `/purchase-orders` |
| `POST` | `/purchase-orders` |
| `GET` | `/purchase-orders/{id}` |
| `POST` | `/purchase-orders/{id}/approve` |
| `POST` | `/purchase-orders/{id}/cancel` |
| `POST` | `/purchase-orders/{id}/close` |
| `POST` | `/purchase-orders/{id}/confirm` |
| `GET` | `/purchase-orders/{id}/document` |
| `POST` | `/purchase-orders/{id}/send` |
| `POST` | `/purchase-orders/{id}/submit` |
| `GET` | `/suppliers` |
| `POST` | `/suppliers` |
| `GET` | `/suppliers/{id}` |
| `PATCH` | `/suppliers/{id}` |
| `POST` | `/suppliers/{id}/prices` |

### products

| Method | Path |
| --- | --- |
| `GET` | `/barcodes/{code}` |
| `GET` | `/categories` |
| `POST` | `/categories` |
| `GET` | `/products` |
| `POST` | `/products` |
| `GET` | `/products/export.csv` |
| `POST` | `/products/import` |
| `GET` | `/products/{id}` |
| `PATCH` | `/products/{id}` |
| `GET` | `/products/{id}/barcodes` |
| `POST` | `/products/{id}/images` |
| `POST` | `/skus/{id}/barcodes` |
| `PATCH` | `/skus/{id}/pricing` |
| `GET` | `/tax-categories` |

### reports

| Method | Path |
| --- | --- |
| `GET` | `/reports/fulfillment` |
| `GET` | `/reports/inventory` |
| `GET` | `/reports/overview` |
| `GET` | `/reports/procurement` |
| `GET` | `/reports/sales` |
| `GET` | `/reports/warehouse` |

### storefront

| Method | Path |
| --- | --- |
| `DELETE` | `/storefront/cart` |
| `GET` | `/storefront/cart` |
| `PUT` | `/storefront/cart/items` |
| `GET` | `/storefront/categories` |
| `GET` | `/storefront/serviceability` |
| `GET` | `/storefront/stores/{storeId}/products` |
| `GET` | `/storefront/stores/{storeId}/products/{productId}` |

### sync

| Method | Path |
| --- | --- |
| `GET` | `/sync/conflicts` |
| `POST` | `/sync/conflicts/{id}/resolve` |
| `POST` | `/sync/devices` |
| `DELETE` | `/sync/devices/{id}` |
| `POST` | `/sync/push` |
| `GET` | `/sync/snapshot` |
| `GET` | `/sync/status` |

### users

| Method | Path |
| --- | --- |
| `GET` | `/permissions` |
| `GET` | `/roles` |
| `PUT` | `/roles` |
| `GET` | `/users` |
| `POST` | `/users` |
| `DELETE` | `/users/{id}` |
| `GET` | `/users/{id}` |
| `PATCH` | `/users/{id}` |

### warehouses

| Method | Path |
| --- | --- |
| `GET` | `/dark-stores` |
| `POST` | `/dark-stores` |
| `GET` | `/dark-stores/{id}` |
| `PATCH` | `/dark-stores/{id}` |
| `GET` | `/dark-stores/{id}/performance` |
| `GET` | `/labels/barcode.svg` |
| `GET` | `/labels/qr.svg` |
| `GET` | `/locations/by-barcode/{barcode}` |
| `GET` | `/warehouses` |
| `POST` | `/warehouses` |
| `GET` | `/warehouses/{id}` |
| `PATCH` | `/warehouses/{id}` |
| `GET` | `/warehouses/{id}/layout` |
| `POST` | `/warehouses/{id}/layout/generate` |
| `POST` | `/warehouses/{id}/locations` |
| `PATCH` | `/warehouses/{id}/locations/{locationId}` |
| `POST` | `/warehouses/{id}/sku-locations` |
