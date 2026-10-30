# Local development

```bash
# prerequisites: Node 20, PostgreSQL 16, Redis 7 (optional), Python 3.12 (AI engine), Go 1.22 (edge agent)
cp .env.example .env                     # set DATABASE_URL to your local database
npm install
npm run db:migrate
SEED_ADMIN_EMAIL=admin@quickstore.local SEED_ADMIN_PASSWORD='Admin#Passw0rd!' SEED_DEMO=true npm run db:seed
npm run dev:api                          # http://localhost:3000 (Swagger at /api/docs)
npm run dev:web                          # admin console  http://localhost:5173
npm run dev -w @quickstore/customer-web  # storefront     http://localhost:5174
cd apps/ai-engine && uvicorn app.main:app --port 8000   # optional
```
