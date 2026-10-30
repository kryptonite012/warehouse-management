#!/usr/bin/env bash
# Run after `migrate`: grants the app role access to tables created by migrations and
# removes UPDATE/DELETE on append-only ledgers.
set -euo pipefail
: "${MIGRATION_DATABASE_URL:?set MIGRATION_DATABASE_URL}"
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO quickstore_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO quickstore_app;
REVOKE UPDATE, DELETE, TRUNCATE ON inventory_movements, audit_logs, order_status_history FROM quickstore_app;
REVOKE ALL ON _prisma_migrations FROM quickstore_app;
SQL
echo "grants applied"
