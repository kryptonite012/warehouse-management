# syntax=docker/dockerfile:1.7
# API + worker image (same code, different command). Build context: repository root.
# OpenSSL (required by Prisma) and the CA bundle are taken from the full Debian image so
# the slim runtime needs no package manager access at build time.
FROM node:20-bookworm AS openssl
RUN mkdir -p /out/lib /out/bin /out/certs \
 && cp -L "$(ldconfig -p | awk '/libssl.so.3 /{print $NF; exit}')" /out/lib/ \
 && cp -L "$(ldconfig -p | awk '/libcrypto.so.3 /{print $NF; exit}')" /out/lib/ \
 && cp /usr/bin/openssl /out/bin/ \
 && cp /etc/ssl/certs/ca-certificates.crt /out/certs/

FROM node:20-bookworm-slim AS base
COPY --from=openssl /out/lib/ /usr/local/lib/
COPY --from=openssl /out/bin/openssl /usr/local/bin/openssl
COPY --from=openssl /out/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN ldconfig && openssl version
COPY infrastructure/docker/certs/ /usr/local/share/ca-certificates/extra/
# Append any extra corporate CAs to the system bundle (no package manager needed).
RUN for c in /usr/local/share/ca-certificates/extra/*.crt; do [ -f "$c" ] && cat "$c" >> /etc/ssl/certs/ca-certificates.crt; done; true
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin-web/package.json apps/admin-web/package.json
COPY apps/customer-web/package.json apps/customer-web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci --workspace @quickstore/api --include-workspace-root --ignore-scripts
COPY database ./database
RUN npx prisma generate --schema database/prisma/schema.prisma
COPY apps/api ./apps/api
RUN npm run build -w @quickstore/api && npm prune --omit=dev --workspace @quickstore/api --include-workspace-root

FROM base AS runtime
ENV NODE_ENV=production
RUN groupadd --system app && useradd --system --gid app --home /app app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=app:app /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=app:app /app/database/prisma ./database/prisma
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY infrastructure/docker/api-entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint
USER app
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["entrypoint"]
CMD ["api"]
