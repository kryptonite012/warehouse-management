# Installation & operations (on-premises)

Everything runs on your own servers. There is no dependency on a public cloud service.

## Requirements

| Role | Minimum (pilot, ≤ 50 stores) | Notes |
| --- | --- | --- |
| Application host | 8 vCPU, 16 GB RAM, 100 GB SSD | API replicas, worker, web, AI engine |
| Database host | 8 vCPU, 32 GB RAM, NVMe, separate disk for WAL archive | can be the same host for pilots |
| Backup target | separate machine / NAS | receives encrypted dumps and WAL |
| Dark store | any Linux / Windows mini PC or the store tablet | runs the Go edge agent (≈10 MB) |

Software: Docker Engine 24+ with Compose v2. For local development: Node 20, Python 3.12, Go 1.22,
PostgreSQL 16, Redis 7.

## First install

```bash
git clone <your mirror of this repository> quickstore && cd quickstore
cp .env.example .env            # then replace every change-me-* value
openssl rand -hex 48            # use for JWT_ACCESS_SECRET
./scripts/generate-dev-certs.sh admin.example.internal,shop.example.internal   # or install your CA-issued cert
docker compose build
docker compose up -d            # migrations and DB grants run automatically before the API starts
docker compose run --rm -e SEED_ADMIN_PASSWORD='<strong password>' api seed
docker compose --profile monitoring up -d   # Prometheus, Alertmanager, Grafana, Loki
```

Open `https://<ADMIN_HOST>` and sign in with `SEED_ADMIN_EMAIL`. Point `SHOP_HOST` DNS at the same
server for the storefront. Add `SEED_DEMO=true` to the seed command to load clearly labelled demo
sites, products and stock.

Behind a TLS-intercepting proxy, place the proxy's CA certificate (`*.crt`) in
`infrastructure/docker/certs/` before `docker compose build`.

## What starts

| Service | Network | Exposed |
| --- | --- | --- |
| `web` (Nginx + both SPAs) | edge, app | 80 → 443 redirect, 443 |
| `api` ×`API_REPLICAS` | app, data | no |
| `worker` | app, data | no |
| `ai-engine` | app | no |
| `postgres`, `redis`, `rabbitmq`, `minio` | data (internal) | **no — never published** |
| `migrate`, `grants` | one-shot | no |
| `grafana` | monitoring | `127.0.0.1:3001` only |

The `app` and `data` networks are `internal: true`: those containers have no route to the
internet and are unreachable from outside the host.

## Upgrades

```bash
git pull && docker compose build
./infrastructure/backup/backup.sh            # always back up first
docker compose up -d                         # migrate -> grants -> rolling API restart
```

Migrations are forward-only and additive by policy; destructive changes ship in two releases
(expand, then contract).

## Health and monitoring

* `GET /health/live`: process is up. `GET /health/ready`: database reachable (503 otherwise).
* Prometheus scrapes every API replica (`/metrics`, internal network only). Alerts are in
  `infrastructure/monitoring/prometheus/alerts.yml`: API down, error rate > 2%, p99 > 500 ms,
  PostgreSQL down or connections > 80%, reservation-failure spikes, no orders during trading hours.
  Route them in `alertmanager.yml`.
* Grafana (`QuickStore API` dashboard) and Loki (all container logs, JSON access logs from Nginx).
* Container logs rotate at 20 MB × 5 files.

## Edge agent per dark store

1. In the console: **Store Sync → Register edge device**. Pick the store and the operations allowed offline, then copy the token.
2. On the store machine:
   ```bash
   EDGE_DEVICE_TOKEN=<token> EDGE_CENTRAL_URL=https://<ADMIN_HOST>/api/v1 EDGE_DATA_DIR=/var/lib/quickstore-edge ./quickstore-edge
   ```
   (or `docker run -v edge:/data -p 8090:8090 -e … quickstore/edge-agent`). Scanners and tablets
   talk to `http://<store-pc>:8090`.

## Payments

Online methods stay disabled (shown as "Not available") until a gateway is configured:
`PAYMENT_PROVIDER=generic-hmac` and `PAYMENT_WEBHOOK_SECRET=…`. Point the gateway's webhook to
`https://<SHOP_HOST>/api/v1/payments/webhooks/generic-hmac`. Gateway-specific adapters (signature
scheme, server-side status verification) implement the `PaymentProvider` interface in
`apps/api/src/modules/payments/gateway.ts`. A gateway that requires outbound verification calls needs
an egress rule from the `app` network to the gateway's API host.
