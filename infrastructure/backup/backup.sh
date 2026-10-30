#!/usr/bin/env bash
# Encrypted, checksummed logical backup of PostgreSQL (+ optional MinIO mirror).
#   BACKUP_ENCRYPTION_KEY=... ./infrastructure/backup/backup.sh
# Output: $BACKUP_DIR/quickstore-<UTC timestamp>.dump.enc and .sha256
# Schedule with cron/systemd on the host, e.g. every 6 hours; combine with WAL archiving for PITR.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY must be set (store it off-host)}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/quickstore-$STAMP.dump.enc"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

echo "[backup] dumping database…"
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 --no-owner \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_ENCRYPTION_KEY -out "$OUT"
sha256sum "$OUT" | awk '{print $1}' > "$OUT.sha256"
SIZE=$(stat -c %s "$OUT")
echo "[backup] wrote $OUT ($SIZE bytes)"

# Record the backup in the database for visibility in operations tooling.
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -qc \
  "INSERT INTO backup_history (id, kind, location, size_bytes, checksum, status, started_at, finished_at)
   VALUES (gen_random_uuid(), 'pg_dump', '$(basename "$OUT")', $SIZE, '$(cat "$OUT.sha256")', 'COMPLETED', now(), now())" || true

if [ -n "${MINIO_BACKUP_TARGET:-}" ]; then
  echo "[backup] mirroring object storage to $MINIO_BACKUP_TARGET…"
  docker compose exec -T minio sh -c "mc alias set local http://127.0.0.1:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null && mc mirror --overwrite local/quickstore /data-backup" || echo "[backup] object storage mirror skipped"
fi

find "$BACKUP_DIR" -name 'quickstore-*.dump.enc*' -mtime +"$RETENTION" -print -delete | sed 's/^/[backup] pruned /'
echo "[backup] done"
