-- FIX-11 (audit 2026-09-03 P1 shop & shipping, P2 courier call in the
-- transaction). Additive: `awb` may be null while a shipment is `creating`
-- (the claim row committed before the courier call) or `failed`; the sync
-- health columns default to "healthy"; the one-shipment-per-order unique index
-- becomes PARTIAL so a cancelled or failed row can be replaced by a new AWB
-- while a double click still cannot register two live ones. The plain
-- order_id index keeps lookups over the replaced rows fast.
DROP INDEX "shipments_order_id_uq";--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "awb" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "next_sync_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "error_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_order_id_active_uq" ON "shipments" USING btree ("order_id") WHERE "shipments"."status" not in ('cancelled', 'failed');--> statement-breakpoint
CREATE INDEX "shipments_order_id_idx" ON "shipments" USING btree ("order_id");