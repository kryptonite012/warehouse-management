.PHONY: up down logs seed test backup verify-backup certs load demo

up:            ## build and start the stack
	docker compose up -d --build
down:
	docker compose down
logs:
	docker compose logs -f --tail=100 api worker web
certs:
	./scripts/generate-dev-certs.sh
seed:          ## SEED_ADMIN_PASSWORD=... make seed
	docker compose run --rm -e SEED_ADMIN_PASSWORD="$(SEED_ADMIN_PASSWORD)" -e SEED_DEMO="$(SEED_DEMO)" api seed
test:
	npm test && (cd apps/ai-engine && pytest -q) && (cd apps/edge-agent && go test ./...)
backup:
	./infrastructure/backup/backup.sh
verify-backup:
	./infrastructure/backup/verify-restore.sh
load:
	node tests/load/run.mjs
demo:
	node scripts/demo-walkthrough.mjs
