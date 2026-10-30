-- Inventory invariants enforced by the database itself, so that no code path
-- (API, worker, manual SQL) can create negative stock or an ambiguous balance.

ALTER TABLE "inventory_balances"
  ADD CONSTRAINT "inventory_balances_non_negative" CHECK (
    "on_hand" >= 0 AND "available" >= 0 AND "reserved" >= 0 AND "damaged" >= 0
    AND "quarantined" >= 0 AND "expired" >= 0 AND "in_transit" >= 0
  ),
  ADD CONSTRAINT "inventory_balances_on_hand_identity" CHECK ("on_hand" = "available" + "reserved");

ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_positive_qty" CHECK ("quantity" > 0);

ALTER TABLE "inventory_reservation_lines"
  ADD CONSTRAINT "inventory_reservation_lines_positive_qty" CHECK ("quantity" > 0);

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_positive_qty" CHECK ("quantity" > 0 AND "picked_qty" >= 0 AND "picked_qty" <= "quantity");

ALTER TABLE "purchase_order_items"
  ADD CONSTRAINT "purchase_order_items_qty" CHECK (
    "ordered_qty" > 0 AND "received_qty" >= 0 AND "accepted_qty" >= 0 AND "rejected_qty" >= 0
    AND "accepted_qty" + "rejected_qty" <= "received_qty"
  );

ALTER TABLE "storage_locations"
  ADD CONSTRAINT "storage_locations_capacity" CHECK ("occupied_units" >= 0 AND ("capacity_units" IS NULL OR "occupied_units" <= "capacity_units"));

-- The movement ledger is append-only. Corrections are new movements, never edits.
CREATE OR REPLACE FUNCTION quickstore_block_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory_movements is append-only (% blocked)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_movements_append_only
  BEFORE UPDATE OR DELETE ON "inventory_movements"
  FOR EACH ROW EXECUTE FUNCTION quickstore_block_ledger_mutation();

-- Audit logs are also immutable.
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION quickstore_block_ledger_mutation();

-- Order status history is immutable.
CREATE TRIGGER order_status_history_append_only
  BEFORE UPDATE OR DELETE ON "order_status_history"
  FOR EACH ROW EXECUTE FUNCTION quickstore_block_ledger_mutation();

-- Product search: trigram index for fast ILIKE search on names.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "products_name_trgm" ON "products" USING gin ("name" gin_trgm_ops);

-- Only one ACTIVE reservation per order.
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_reservations_one_active_per_order"
  ON "inventory_reservations" ("order_id") WHERE "status" = 'ACTIVE' AND "order_id" IS NOT NULL;
