# Seed

The seed lives in `apps/api/src/seed.ts` so it ships inside the API image.

```bash
# local
SEED_ADMIN_EMAIL=admin@quickstore.local SEED_ADMIN_PASSWORD='…' SEED_DEMO=true npm run db:seed
# docker
docker compose run --rm -e SEED_ADMIN_PASSWORD='…' api seed
```

It creates permissions, the default role templates, the organization and (optionally) a super admin.
`SEED_DEMO=true` adds a clearly labelled `DEMO-*` warehouse, dark store, products and opening stock
(booked through the inventory ledger).
