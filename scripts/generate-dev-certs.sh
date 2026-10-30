#!/usr/bin/env bash
# Self-signed certificate for local/staging use. Replace with your internal CA's
# certificate (or ACME) in production: infrastructure/nginx/certs/server.{crt,key}.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/infrastructure/nginx/certs"
HOSTS="${1:-admin.quickstore.local,shop.quickstore.local,localhost}"
mkdir -p "$DIR"
SAN=$(echo "$HOSTS" | tr ',' '\n' | awk '{printf "%sDNS:%s", (NR>1?",":""), $0}')
openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout "$DIR/server.key" -out "$DIR/server.crt" \
  -subj "/CN=$(echo "$HOSTS" | cut -d, -f1)" -addext "subjectAltName=$SAN" 2>/dev/null
chmod 600 "$DIR/server.key"
echo "certificate written to $DIR (SAN: $SAN)"
