ALTER TABLE "orders" ADD COLUMN "delivery_otp" TEXT;
ALTER TABLE "picking_tasks" ADD COLUMN "wave_id" UUID;
CREATE INDEX "picking_tasks_wave_id_idx" ON "picking_tasks" ("wave_id");
-- One live picking task per order.
CREATE UNIQUE INDEX "picking_tasks_one_open_per_order" ON "picking_tasks" ("order_id") WHERE "status" IN ('PENDING', 'ASSIGNED', 'IN_PROGRESS');
-- One live delivery assignment per order.
CREATE UNIQUE INDEX "delivery_assignments_one_open_per_order" ON "delivery_assignments" ("order_id") WHERE "status" IN ('ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY');
