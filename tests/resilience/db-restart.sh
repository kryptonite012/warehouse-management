#!/usr/bin/env bash
# TEST 10 — database server restarts unexpectedly.
# Expected: committed data survives, readiness reports the outage, and the API recovers by itself.
set -euo pipefail
cd "$(dirname "$0")/../.."
dc() { docker compose "$@"; }
q() { dc exec -T postgres psql -U "${POSTGRES_USER:-quickstore}" -d "${POSTGRES_DB:-quickstore}" -tAc "$1"; }
ready() { dc exec -T api node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log('down');process.exit(0)})"; }

before_orders=$(q "select count(*) from orders")
before_moves=$(q "select count(*) from inventory_movements")
before_sum=$(q "select coalesce(sum(on_hand),0) from inventory_balances")
echo "before: orders=$before_orders movements=$before_moves on_hand=$before_sum readiness=$(ready)"

echo "killing postgres with SIGKILL (no clean shutdown)…"
dc kill -s SIGKILL postgres >/dev/null
sleep 2
echo "readiness while down: $(ready)"

dc start postgres >/dev/null
for i in $(seq 1 30); do
  dc exec -T postgres pg_isready -q && break
  sleep 2
done
sleep 3
after_orders=$(q "select count(*) from orders")
after_moves=$(q "select count(*) from inventory_movements")
after_sum=$(q "select coalesce(sum(on_hand),0) from inventory_balances")
status=$(ready)
echo "after:  orders=$after_orders movements=$after_moves on_hand=$after_sum readiness=$status"

[ "$before_orders" = "$after_orders" ] && [ "$before_moves" = "$after_moves" ] && [ "$before_sum" = "$after_sum" ] && [ "$status" = "200" ] \
  && echo "PASS: data intact and API recovered without restart" || { echo "FAIL"; exit 1; }
