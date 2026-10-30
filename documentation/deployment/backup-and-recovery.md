# Backup, recovery, RPO & RTO

## Mechanisms

| Layer | Mechanism | Frequency |
| --- | --- | --- |
| PostgreSQL logical | `infrastructure/backup/backup.sh`: `pg_dump -Fc`, AES-256 (PBKDF2, 200k iterations) encrypted, SHA-256 checksum, recorded in `backup_history` | every 6 h (cron) |
| PostgreSQL PITR | continuous WAL archiving (`archive_mode=on`, `archive_timeout=300`) to the `pgwal` volume; sync it to the backup host | continuous |
| Object storage | `MINIO_BACKUP_TARGET` mirror in `backup.sh` | with each backup |
| Edge journals | durable on each store; replayed to central after outages | continuous |
| Configuration | `.env` + certificates, stored in your secrets vault (not in git) | on change |

Example host crontab:

```
0 */6 * * *  cd /opt/quickstore && ./infrastructure/backup/backup.sh >> /var/log/quickstore-backup.log 2>&1
30 3 * * 0   cd /opt/quickstore && ./infrastructure/backup/verify-restore.sh >> /var/log/quickstore-restore-test.log 2>&1
*/5 * * * *  rsync -a --remove-source-files /var/lib/docker/volumes/quickstore_pgwal/_data/ backup-host:/srv/quickstore/wal/
```

`BACKUP_ENCRYPTION_KEY` must be stored off-host (password manager / HSM). Without it, backups cannot be restored.

## Restore testing

`verify-restore.sh` restores the newest dump into a scratch database, prints row counts and
checks **ledger integrity**: every `inventory_balances.on_hand` must equal the net of its
movements. Verified during development:

```
select count(*) from orders -> 1
select count(*) from inventory_movements -> 20
select coalesce(sum(on_hand),0) from inventory_balances -> 2300
balances not matching ledger: 0
[verify] PASS
```

## Restoring production

```bash
docker compose stop api worker
CONFIRM=yes ./infrastructure/backup/restore.sh backups/quickstore-<stamp>.dump.enc quickstore
docker compose up -d
```

Point-in-time recovery: restore the most recent base backup into a fresh data directory, set
`restore_command = 'cp /wal-archive/%f %p'` and `recovery_target_time = '<UTC timestamp>'`, create
`recovery.signal`, start PostgreSQL, then promote.

## Objectives for the reference deployment

These follow from the mechanisms above. Re-measure them on your hardware with a restore drill.

| Scenario | RPO (max data loss) | RTO (time to service) |
| --- | --- | --- |
| API / worker container crash | 0 | < 1 min (restart policy; second replica keeps serving) |
| PostgreSQL process crash | 0 (WAL crash recovery; verified by `tests/resilience/db-restart.sh`) | 1–2 min |
| Database host loss, WAL shipped every 5 min | ≤ 5 min | 30–60 min (provision, restore base + replay WAL) |
| Logical restore only (no WAL) | ≤ 6 h | 15–30 min at pilot data volumes |
| Dark store loses connectivity | 0 for journalled operations | n/a (store keeps working offline within its allowed operations) |

For RPO ≈ 0 on host loss, add a streaming replica (`wal_level=replica` and `max_wal_senders`
are already set) on a second host and fail over to it.
