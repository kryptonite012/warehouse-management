#!/usr/bin/env bash
# Restore an encrypted backup into a database (default: a scratch database, never in place).
#   ./infrastructure/backup/restore.sh backups/quickstore-<stamp>.dump.enc [target_db]
# Restoring over production requires TARGET=quickstore and CONFIRM=yes, with the API and worker stopped.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a
FILE="${1:?backup file required}"
TARGET="${2:-quickstore_restore_check}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set}"

if [ -f "$FILE.sha256" ] && [ "$(sha256sum "$FILE" | awk '{print $1}')" != "$(cat "$FILE.sha256")" ]; then
  echo "[restore] checksum mismatch — refusing to restore" >&2
  exit 1
fi
if [ "$TARGET" = "$POSTGRES_DB" ] && [ "${CONFIRM:-}" != "yes" ]; then
  echo "[restore] refusing to overwrite $POSTGRES_DB without CONFIRM=yes (stop api/worker first)" >&2
  exit 1
fi

echo "[restore] recreating database $TARGET…"
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -qc "DROP DATABASE IF EXISTS \"$TARGET\" WITH (FORCE)" -c "CREATE DATABASE \"$TARGET\""
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_ENCRYPTION_KEY -in "$FILE" \
  | docker compose exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$TARGET" --no-owner --exit-on-error
echo "[restore] restored into $TARGET"
