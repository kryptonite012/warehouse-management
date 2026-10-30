#!/bin/sh
# Usage: entrypoint api | worker | migrate | seed
set -eu
case "${1:-api}" in
  migrate)
    # Migrations run with the schema-owner role, never the restricted app role.
    exec env DATABASE_URL="${MIGRATION_DATABASE_URL:-$DATABASE_URL}" npx prisma migrate deploy --schema database/prisma/schema.prisma
    ;;
  api)
    exec node apps/api/dist/main.js
    ;;
  worker)
    exec node apps/api/dist/worker.js
    ;;
  seed)
    exec env DATABASE_URL="${MIGRATION_DATABASE_URL:-$DATABASE_URL}" node apps/api/dist/seed.js
    ;;
  *)
    exec "$@"
    ;;
esac
