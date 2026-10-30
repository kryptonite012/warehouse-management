#!/usr/bin/env bash
# One-command start for QuickStore.
#   ./start.sh            start (first run generates secrets, certificate, admin account)
#   ./start.sh --rebuild  rebuild images after pulling new code
#   ./start.sh --stop     stop everything (data is kept)
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1;32m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

if [ "${1:-}" = "--stop" ]; then docker compose down; exit 0; fi

command -v docker >/dev/null || die "Docker is not installed. Install Docker Desktop: https://docs.docker.com/get-docker/"
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop and try again."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (included with Docker Desktop)."
command -v openssl >/dev/null || die "openssl is required (included with Git Bash, macOS and Linux)."

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

if [ ! -f .env ]; then
  project="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
  if docker volume inspect "${project}_pgdata" >/dev/null 2>&1; then
    die "Found an existing database volume but no .env (its passwords are lost).
  Restore your old .env, or wipe the old data with:  docker compose down -v"
  fi
  say "First run: creating .env with random secrets"
  rnd() { openssl rand -hex "${1:-16}"; }
  HTTP_PORT=80; HTTPS_PORT=443
  if ! port_free 80 || ! port_free 443; then HTTP_PORT=8080; HTTPS_PORT=8443; fi
  ADMIN_PASSWORD="Qs-$(rnd 6)-A1"
  sed -e "s/change-me-postgres/$(rnd)/g" \
      -e "s/change-me-app-db/$(rnd)/g" \
      -e "s/change-me-redis/$(rnd)/g" \
      -e "s/change-me-rabbit/$(rnd)/g" \
      -e "s/change-me-minio-secret/$(rnd)/g" \
      -e "s/change-me-grafana/$(rnd 8)/g" \
      -e "s/change-me-access-secret-at-least-32-chars/$(rnd 48)/" \
      -e "s/^HTTP_PORT=.*/HTTP_PORT=$HTTP_PORT/" \
      -e "s/^HTTPS_PORT=.*/HTTPS_PORT=$HTTPS_PORT/" \
      -e "s/^SEED_ADMIN_PASSWORD=.*/SEED_ADMIN_PASSWORD=$ADMIN_PASSWORD/" \
      -e "s/^SEED_DEMO=.*/SEED_DEMO=true/" \
      -e "s/^BACKUP_ENCRYPTION_KEY=.*/BACKUP_ENCRYPTION_KEY=$(rnd 24)/" \
      .env.example > .env
  chmod 600 .env
fi
set -a; . ./.env; set +a

if [ ! -f infrastructure/nginx/certs/server.crt ]; then
  say "Creating a local TLS certificate"
  ./scripts/generate-dev-certs.sh "$ADMIN_HOST,$SHOP_HOST,localhost" >/dev/null
fi

say "Starting containers (first build takes a few minutes)"
if [ "${1:-}" = "--rebuild" ]; then docker compose up -d --build; else docker compose up -d; fi

say "Waiting for the API to become healthy"
for i in $(seq 1 90); do
  if docker compose ps api --format '{{.Status}}' 2>/dev/null | grep -q healthy; then break; fi
  [ "$i" = 90 ] && die "API did not become healthy. See: docker compose logs api"
  sleep 2
done

say "Creating the admin account and demo data (safe to repeat)"
docker compose run --rm -e SEED_ADMIN_EMAIL="$SEED_ADMIN_EMAIL" -e SEED_ADMIN_PASSWORD="$SEED_ADMIN_PASSWORD" \
  -e SEED_DEMO="$SEED_DEMO" api seed | tail -3

suffix=""; [ "$HTTPS_PORT" != "443" ] && suffix=":$HTTPS_PORT"
missing_hosts=""
getent hosts "$ADMIN_HOST" >/dev/null 2>&1 || grep -qs "$ADMIN_HOST" /etc/hosts /c/Windows/System32/drivers/etc/hosts 2>/dev/null || missing_hosts=1

cat <<EOF

  ┌──────────────────────────────────────────────────────────────────┐
  │  QuickStore is running                                           │
  └──────────────────────────────────────────────────────────────────┘
  Admin console : https://$ADMIN_HOST$suffix
  Customer shop : https://$SHOP_HOST$suffix      (try PIN code 560038)
  API docs      : https://$ADMIN_HOST$suffix/api/docs
  Mobile picker : https://$ADMIN_HOST$suffix/ops/pick     Rider: /rider

  Admin login   : $SEED_ADMIN_EMAIL
  Password      : $SEED_ADMIN_PASSWORD      (stored in .env)

  Your browser will warn about the self-signed certificate — choose "Advanced → Proceed".
  Stop with: ./start.sh --stop
EOF
if [ -n "$missing_hosts" ]; then
cat <<EOF

  ⚠ One-time step: add this line to your hosts file
      127.0.0.1 $ADMIN_HOST $SHOP_HOST
    macOS/Linux:  sudo sh -c 'echo "127.0.0.1 $ADMIN_HOST $SHOP_HOST" >> /etc/hosts'
    Windows:      edit C:\\Windows\\System32\\drivers\\etc\\hosts as Administrator
EOF
fi
