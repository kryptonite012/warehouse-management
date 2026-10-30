# Staging

Mirror production with `SEED_DEMO=true` and a copy of the latest *restored* backup
(`infrastructure/backup/restore.sh <dump> quickstore` on the staging host). Run the load
scenarios (`tests/load/run.mjs`) and `tests/resilience/db-restart.sh` before every release.
