# Security

## Controls

| Area | Implementation |
| --- | --- |
| Transport | TLS 1.2/1.3 at Nginx, HTTP→HTTPS redirect, HSTS. Internal networks are not routable from outside. |
| Passwords | bcrypt (cost 12). Policy: 10+ chars, upper, lower and a digit. Constant-time path for unknown users. |
| Login abuse | Per-IP rate limits (Nginx + API, shared through Redis), account lockout after `LOGIN_MAX_FAILED_ATTEMPTS`, every attempt logged in `login_attempts`, lockouts raised as security events. |
| Sessions | 15-min JWT access tokens bound to a server-side session. Refresh tokens are opaque, stored hashed and single-use; reuse revokes the whole token family and raises `REFRESH_TOKEN_REUSE`. Logout and password reset revoke sessions. Users can list and revoke their own sessions. |
| Authorization | Global guard: authentication, then actor type (employee / customer / edge device), then permission. Permissions are loaded from the DB on each request, so revocation is immediate. Roles are configurable; nobody can grant permissions they don't hold. |
| Resource scope | Users can be limited to regions or sites; every site-bound query and mutation checks scope (`assertWarehouseAccess`, `warehouseScopeFilter`). |
| Separation of duties | An adjustment requester can't approve it; write-offs need `inventory.write_off`; a PO creator can't approve it; PO approval limits per role; a different user must reconcile a count. Pickers have no pricing or write-off permissions (tested). |
| Customers vs staff | Separate account tables and token kinds; customers can only reach storefront, cart, own orders and profile. |
| Sensitive fields | Purchase prices hidden without pricing or procurement permissions. The delivery OTP is visible only to the customer. Password hashes and tokens are never selected into responses. |
| Input validation | DTO validation with whitelisting (`forbidNonWhitelisted`) on every endpoint. Prisma parameterises all SQL; the one dynamic statement uses a fixed column map. CSV export neutralises spreadsheet formulas. |
| XSS / clickjacking | React escaping; strict CSP (`script-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy. Printable documents HTML-escape all data. |
| CSRF | Not applicable to the API: it uses bearer tokens from session storage, not cookies. Payment webhooks are authenticated by HMAC signature. |
| Payments | No card data stored or proxied. HMAC-SHA256 webhook verification over the raw body with timing-safe compare; amount checks; exactly-once processing; forged and mismatched callbacks raise security events. |
| Auditing | Append-only `audit_logs` (trigger + revoked UPDATE/DELETE) for every privileged mutation and every authorization denial, with IP and request id. |
| Database access | Runtime role `quickstore_app` has DML only: no DDL, no UPDATE/DELETE on ledgers or audit, no migration table. Migrations run as the schema owner in a one-shot container. SCRAM-SHA-256 auth. |
| Secrets | `.env` (never committed) or Docker/Swarm secrets. JWT secret length enforced at startup. Device tokens and reset tokens stored only as SHA-256 hashes and shown once. |
| Backups | AES-256 encrypted, checksummed, key stored off-host, restore drills automated. |
| Containers | Non-root users, no package managers needed at runtime, health checks, only the web container publishes ports. |

## Data retention & privacy

See the retention table in [database/erd.md](../database/erd.md#retention). Orders keep an
address snapshot for legal and financial records. Customer accounts can be anonymised after
`privacy.customer_retention_days` of inactivity.

## Reporting

Report vulnerabilities privately to the repository owner. Do not open public issues for security problems.
