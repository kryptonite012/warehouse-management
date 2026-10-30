# Worker

Runs periodic jobs defined in `apps/api/src/worker.ts`, sharing the API's domain services
so business rules exist in exactly one place.

| Job | Interval | What it does |
| --- | --- | --- |
| `orders.cancel_unpaid` | 60 s | Cancels orders still awaiting payment after the reservation TTL and releases their stock |
| `reservations.expire` | 60 s | Releases any other ACTIVE reservation past `expires_at` (compare-and-set, exactly once) |
| `inventory.expiry_sweep` | 1 h | Moves unreserved units of expired batches to the EXPIRED bucket |
| `inventory.low_stock_alerts` | 15 min | One notification per (site, SKU, day) at or below reorder point |

Each job takes a row lease in `job_leases`, so you can run several worker replicas safely.
