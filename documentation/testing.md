# Testing & verification

| Layer | Command | What it covers |
| --- | --- | --- |
| API integration (Jest + real PostgreSQL) | `npm test` | 34 scenarios across 6 suites; each run resets a dedicated test database via migrations |
| AI engine (pytest) | `cd apps/ai-engine && pytest` | model forecast fields and ranges, rule fallback labelling, anomaly detection |
| Edge agent (Go) | `cd apps/edge-agent && go test ./...` | offline queueing, restart, exactly-once replay, torn-write recovery |
| End-to-end business flow | `node scripts/demo-walkthrough.mjs` | PO → GRN → QC → transfer → storefront order → pick → pack → dispatch → OTP delivery, over HTTP |
| Database crash | `tests/resilience/db-restart.sh` | SIGKILL PostgreSQL in the running stack; data intact; readiness 503 → 200 |
| Backups | `infrastructure/backup/verify-restore.sh` | encrypted dump restores; ledger-vs-balance integrity check |
| Load | `node tests/load/run.mjs` (or k6 in `tests/load/k6`) | search, scanning, reservations, hot-SKU contention, orders, sync, dashboards |

## Critical scenarios

| # | Scenario | Expected | Test |
| --- | --- | --- | --- |
| 1 | Two (or ten) customers buy the last unit | exactly one reservation succeeds | `inventory.e2e-spec.ts` "TEST 1" (10 concurrent requests); load run: 50 units, 4,784 attempts → 50 × 201, rest 409 |
| 2 | Order cancelled after reservation | released exactly once | `inventory.e2e-spec.ts` "TEST 2" (5 concurrent releases) and `commerce.e2e-spec.ts` (4 concurrent cancels, 1 RELEASE movement) |
| 3 | Store loses connectivity | permitted local operations continue | `apps/edge-agent/internal/agent` `TestOfflineThenReconnect` (queueing, offline barcode lookup, non-permitted ops refused) |
| 4 | Store reconnects | queued operations sync without duplication | same Go test (agent restart included) + `sync.e2e-spec.ts` "TEST 4" (same batch pushed 3× concurrently → applied once) |
| 5 | Expired batch selected for picking | FEFO and expiry validation block it | `inventory.e2e-spec.ts` "TEST 5" (allocation) + `fulfillment.e2e-spec.ts` (batch expires after reservation → `BATCH_EXPIRED` at scan) |
| 6 | Unauthorized stock adjustment | rejected and logged | `inventory.e2e-spec.ts` "TEST 6" (403 + `DENIED` audit row, balance unchanged) |
| 7 | Partial supplier shipment | received / pending tracked | `procurement.e2e-spec.ts` "TEST 7" (100 ordered, 60 received → pending 40, QC split, over-receipt blocked) |
| 8 | Duplicate payment callbacks | processed once | `commerce.e2e-spec.ts` "TEST 8" (5 concurrent identical webhooks → 1 processed, 4 duplicates; forged signature 401; wrong amount 422) |
| 9 | Two managers update the same record | no silent data loss | `sync.e2e-spec.ts` "TEST 9" (concurrent PATCH, same version → one 200, one 409 `STALE_VERSION`) |
| 10 | Database restarts unexpectedly | data recovered, health checks verify | `tests/resilience/db-restart.sh` against the Docker stack |

## Load test results (reference run)

Environment: a single API process (no replicas), PostgreSQL 16 on the same 4-vCPU / 16 GB VM,
25 concurrent virtual users, 10 s per scenario. These are measurements of this environment,
not capacity guarantees. Re-run `tests/load/run.mjs` on your hardware to establish your own baseline.

| Scenario | Requests/s | p50 ms | p95 ms | p99 ms | Errors |
| --- | --- | --- | --- | --- | --- |
| Product search (storefront) | 236 | 102 | 164 | 257 | 0 |
| Warehouse barcode scans | 840 | 29 | 46 | 61 | 0 |
| Inventory reservations (spread SKUs) | 277 | 87 | 127 | 159 | 0 |
| Hot-SKU contention (50 units) | 478 | 48 | 80 | 163 | 0 (50 × 201, 4,734 × 409, **no oversell**) |
| Concurrent checkouts (2 SKUs each) | 72 | 300 | 663 | 924 | 0 |
| Edge sync pushes, all on one batch row | 121–127 | 150–158 | 509–541 | 728–826 | 0 |
| Dashboard overview | 343 | 70 | 107 | 132 | 0 |

The sync figure is a worst case: 25 concurrent pushes all damage the *same* batch, so they
serialize on that balance row by design. That lock is the guarantee against negative stock.
Real stores spread operations across many SKUs and batch up to 500 operations per push.

## Service-level objectives (proposed)

| SLO | Target |
| --- | --- |
| API availability (non-5xx) | 99.9 % monthly |
| Read endpoints p95 | < 300 ms |
| Checkout p95 | < 800 ms |
| Reservation correctness | 0 oversells (checked continuously by CHECK constraints) |
| Offline replay | 100 % of journalled operations applied or surfaced as conflicts |

Prometheus alert rules implement the availability and latency SLOs.
