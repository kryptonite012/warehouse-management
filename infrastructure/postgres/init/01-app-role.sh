#!/bin/bash
# Creates the restricted runtime role used by the API and worker.
# The schema owner (POSTGRES_USER) runs migrations; the app role can only read/write rows.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'quickstore_app') THEN
    CREATE ROLE quickstore_app LOGIN PASSWORD '${APP_DB_PASSWORD}';
  END IF;
END \$\$;
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO quickstore_app;
GRANT USAGE ON SCHEMA public TO quickstore_app;
ALTER DEFAULT PRIVILEGES FOR ROLE "$POSTGRES_USER" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO quickstore_app;
ALTER DEFAULT PRIVILEGES FOR ROLE "$POSTGRES_USER" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO quickstore_app;
SQL
