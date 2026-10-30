# syntax=docker/dockerfile:1.7
# Builds both SPAs and serves them (plus the API reverse proxy) from Nginx.
FROM node:20-alpine AS build
COPY infrastructure/docker/certs/ /usr/local/share/ca-certificates/extra/
# Append any extra corporate CAs to the system bundle (no package manager needed).
RUN for c in /usr/local/share/ca-certificates/extra/*.crt; do [ -f "$c" ] && cat "$c" >> /etc/ssl/certs/ca-certificates.crt; done; true
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin-web/package.json apps/admin-web/package.json
COPY apps/customer-web/package.json apps/customer-web/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci --workspace @quickstore/admin-web --workspace @quickstore/customer-web --ignore-scripts
COPY apps/admin-web ./apps/admin-web
COPY apps/customer-web ./apps/customer-web
RUN npm run build -w @quickstore/admin-web && npm run build -w @quickstore/customer-web

FROM nginx:1.27-alpine
COPY --from=build /app/apps/admin-web/dist /usr/share/nginx/admin
COPY --from=build /app/apps/customer-web/dist /usr/share/nginx/shop
COPY infrastructure/nginx/templates /etc/nginx/templates
COPY infrastructure/nginx/snippets /etc/nginx/snippets
COPY infrastructure/nginx/nginx.conf /etc/nginx/nginx.conf
EXPOSE 80 443
