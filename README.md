# QuickStore

An operating platform for quick-commerce businesses: central warehouses, dark stores, suppliers,
customers, riders, and everything between them.

```
SUPPLIER → PROCUREMENT → CENTRAL WAREHOUSE → DARK STORE → INVENTORY → CUSTOMER ORDER
        → PICKING → PACKING → DISPATCH → DELIVERY → CUSTOMER
```

It runs entirely on your own servers (Docker Compose, no cloud dependencies). Dark stores keep
working when their link to head office drops.

| | |
| --- | --- |
| **API** | NestJS + TypeScript modular monolith, PostgreSQL 16 via Prisma, Redis, RabbitMQ |
| **Admin console** | React + Vite + Tailwind + TanStack Query + Zustand + Recharts, with mobile picker / packer / rider apps |
| **Storefront** | React customer app with live stock |
| **Worker** | Leased background jobs and an outbox relay to RabbitMQ |
| **AI engine** | Python FastAPI, scikit-learn (optional; rule fallbacks are labelled as rules) |
| **Edge agent** | Go service per dark store with a durable offline journal |
| **Ops** | Nginx (TLS), Prometheus, Alertmanager, Grafana, Loki, encrypted backups with restore verification |

## Quick start (one command)

You need Docker Desktop (or Docker Engine + Compose v2) and Git. On Windows, use Git Bash or WSL.

```bash
git clone https://github.com/kryptonite012/warehouse-management.git
cd warehouse-management
./start.sh
```

On the first run, `start.sh` generates random secrets in `.env`, creates a local TLS certificate,
builds and starts every container, runs migrations, and creates an admin account with demo data.
It then prints the URLs and the admin password. If ports 80/443 are busy it uses 8080/8443.

Add this line to your hosts file once (the script reminds you):

```
127.0.0.1 admin.quickstore.local shop.quickstore.local
```

* Admin console: `https://admin.quickstore.local`. Sign in as `admin@quickstore.local` with the printed password.
* Storefront: `https://shop.quickstore.local`. Use PIN code `560038` for the demo store.
* API docs: `https://admin.quickstore.local/api/docs`.
* Stop with `./start.sh --stop`; after pulling new code use `./start.sh --rebuild`.
* Monitoring: `docker compose --profile monitoring up -d`, then Grafana on `127.0.0.1:3001`.

Then exercise the whole business flow end to end through the API:

```bash
API=https://admin.quickstore.local/api/v1 NODE_EXTRA_CA_CERTS=infrastructure/nginx/certs/server.crt \
  node scripts/demo-walkthrough.mjs
```

Local development without Docker: [deployment/development](deployment/development/README.md).

## What's inside

| Domain | Highlights |
| --- | --- |
| Identity & access | Email/phone login, lockout, single-use rotating refresh tokens with reuse detection, password reset, session management, 14 configurable role templates, region/site scoping, segregation of duties, full audit trail |
| Warehouses & stores | Site registry, zone→aisle→rack→shelf→bin layout generator, Code128/QR labels, temperature-compatible slotting, visual occupancy map, store KPIs |
| Catalog | Products, variants/SKUs, multiple barcodes, CSV import (validate-then-commit) and export, image upload to MinIO, purchase-price redaction |
| Inventory | Append-only ledger, explicit buckets (available / reserved / damaged / quarantined / expired / in-transit) enforced by DB constraints, FEFO, reservations with exactly-once release and TTL, two-person adjustments, blind cycle counts, transfers with in-transit tracking, expiry sweep, low-stock alerts |
| Procurement | Suppliers with price history and performance, purchase orders with role-based approval limits, printable PO, partial receipts, QC quarantine, accept/damage/reject, price-discrepancy flags |
| Commerce | Serviceability by PIN/radius, live-availability storefront, cart, coupons, idempotent checkout, store allocation (coverage → capacity → load → distance), order state machine with full history, returns |
| Payments | Provider abstraction, HMAC-verified exactly-once webhooks, COD, refunds, reconciliation. Online methods stay disabled until a gateway is configured |
| Fulfilment | FEFO pick lists routed by bin sequence, batch/wave picking, barcode verification, expiry re-check at scan, short picks, pack verification, labels |
| Delivery | Riders, shifts, atomic auto-assignment, status flow, OTP proof of delivery, failed-attempt handling. GPS is recorded only from real device fixes |
| Analytics | Live KPIs, hourly/daily sales, category and store performance, inventory distribution, expiry buckets, stage-by-stage fulfilment bottlenecks, warehouse and supplier performance |
| Intelligence | Gradient-boosted SKU demand forecasts with coverage-based confidence, replenishment recommendations with explanations, isolation-forest anomaly detection. Every result shows method, model version and data period |
| Offline stores | Edge agent with fsync'd journal, intent-based sync (no last-write-wins on stock), exactly-once replay, conflict queue, disconnected stores removed from routing |

Details: [architecture](documentation/architecture/overview.md) ·
[offline sync](documentation/architecture/offline-sync.md) ·
[database & ERD](documentation/database/erd.md) ·
[API](documentation/api/README.md) ·
[installation](documentation/deployment/installation.md) ·
[backup / RPO / RTO](documentation/deployment/backup-and-recovery.md) ·
[security](documentation/security/security.md) ·
[testing](documentation/testing.md) ·
[user guides](documentation/user-guides/README.md)

## Repository layout

```
apps/
  api/            NestJS API (modules per domain), worker entry, seed, Jest e2e tests
  admin-web/      admin console + mobile ops (/ops/pick, /ops/pack, /rider)
  customer-web/   customer storefront
  worker/         worker launcher (jobs live in apps/api/src/worker.ts)
  ai-engine/      FastAPI + scikit-learn forecasting and anomaly service
  edge-agent/     Go dark-store agent
database/prisma/  schema and SQL migrations
infrastructure/   docker images, nginx, postgres, monitoring, backup scripts
deployment/       development / staging / production notes and overrides
documentation/    architecture, database, API, deployment, security, testing, user guides
scripts/          certificates, DB grants, demo walkthrough
tests/            load tests (Node runner + k6) and resilience checks
```

## Tests

```bash
npm test                                   # 34 API integration scenarios on real PostgreSQL
cd apps/ai-engine && pytest                # AI engine
cd apps/edge-agent && go test ./...        # edge agent
tests/resilience/db-restart.sh             # against a running stack
node tests/load/run.mjs                    # load scenarios
```

The ten critical scenarios (last-unit race, exactly-once release, offline operation, reconnect
without duplicates, expired batch at pick, unauthorized adjustment, partial shipment, duplicate
payment callbacks, conflicting edits, database crash) each map to an automated test; see
[documentation/testing.md](documentation/testing.md).

## Status and known limits

* **Payment gateways**: the generic HMAC adapter is complete. Gateway-specific adapters (e.g. a
  particular Indian PSP) need to implement `PaymentProvider` with that provider's signature format.
* **Maps, routing, SMS and WhatsApp** integrations are not bundled. ETAs show as unavailable, and
  notifications are stored in-app, until a provider is configured. Nothing is simulated.
* **Enterprise SSO and MFA**: the schema has the fields (`mfa_enabled`, `mfa_secret`), but TOTP/SSO
  flows are not implemented yet.
* **Excel export**: CSV only (opens in Excel).
* **Capacity**: load figures in `documentation/testing.md` come from a single 4-vCPU VM. Validate
  your target (50–500 stores) on your own hardware with `tests/load`.

## License

MIT. See [LICENSE](LICENSE).
