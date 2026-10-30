# QuickStore edge agent

Runs inside each dark store on the store LAN. Scanners and tablets talk to it; it talks to central.

* **Durable journal** – every operation is fsync'd to `ops.jsonl` before the scanner gets `202 Accepted`.
* **Offline operation** – only operations in the device's `allowedOps` (assigned centrally) are accepted.
  Barcode lookups use the last snapshot. Stock figures are *advisory* while offline.
* **Exactly-once sync** – each op has a client UUID; central de-duplicates, the agent records acks in
  `acks.jsonl`, so restarts and retries never double-apply.
* **Conflicts** – if central rejects an intent (e.g. stock already sold), it is listed under
  `needsReview` in `/status` and in the admin console's sync conflict queue for manual reconciliation.

```bash
# 1. register the device (store manager / admin token)
curl -X POST $API/sync/devices -H "Authorization: Bearer $TOKEN" \
  -d '{"warehouseId":"<store-id>","name":"Store tablet","allowedOps":["PICK_SCAN","DAMAGE_REPORT"]}'
# 2. run it with the returned token
EDGE_DEVICE_TOKEN=... EDGE_CENTRAL_URL=https://central/api/v1 ./quickstore-edge
```

| Local endpoint | Purpose |
| --- | --- |
| `GET /status` | online flag, last sync, pending queue, items needing review |
| `GET /lookup/{barcode}` | offline barcode → SKU lookup |
| `POST /ops/pick-scan` · `/ops/damage` · `/ops/count` · `/ops/transfer-receive` | queue an operation (`{performedBy, payload}`) |
