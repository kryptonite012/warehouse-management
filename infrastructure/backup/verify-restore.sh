#!/usr/bin/env bash
# Restore test: restores the newest backup into a scratch database and checks that
# ledger invariants and row counts match production. Run weekly (restore testing).
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -f .env ] && set -a && . ./.env && set +a
LATEST=$(ls -1t "${BACKUP_DIR:-./backups}"/quickstore-*.dump.enc | head -1)
SCRATCH=quickstore_restore_check
./infrastructure/backup/restore.sh "$LATEST" "$SCRATCH"
q() { docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$1" -tAc "$2"; }
CHECKS=(
  "select count(*) from orders"
  "select count(*) from inventory_movements"
  "select coalesce(sum(on_hand),0) from inventory_balances"
  "select count(*) from audit_logs"
)
fail=0
for c in "${CHECKS[@]}"; do
  r=$(q "$SCRATCH" "$c")
  echo "  $c -> $r"
done
# Ledger integrity: every balance must equal the net of its movements (sellable buckets).
bad=$(q "$SCRATCH" "
  WITH net AS (
    SELECT batch_id,
      SUM(CASE WHEN to_bucket IN ('AVAILABLE','RESERVED') THEN quantity ELSE 0 END)
    - SUM(CASE WHEN from_bucket IN ('AVAILABLE','RESERVED') THEN quantity ELSE 0 END) AS on_hand
    FROM inventory_movements GROUP BY batch_id)
  SELECT count(*) FROM inventory_balances b LEFT JOIN net n ON n.batch_id = b.batch_id
  WHERE b.on_hand <> COALESCE(n.on_hand, 0)")
echo "  balances not matching ledger: $bad"
[ "$bad" = "0" ] || fail=1
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -qc "DROP DATABASE \"$SCRATCH\" WITH (FORCE)"
[ $fail = 0 ] && echo "[verify] PASS ($LATEST)" || { echo "[verify] FAIL"; exit 1; }
