ALTER TABLE "order_items" ADD COLUMN "vat_rate_bp" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "vat_rate_bp" integer;--> statement-breakpoint
-- FIX-12 (audit 2026-09-03 P1 "one global VAT rate, no per-product rate, no
-- effective dating"). `products.vat_rate_bp` / `order_items.vat_rate_bp` are
-- nullable: null = the STANDARD rate in force on the order date, which now
-- comes from the effective-dated `invoice.vatStandardRates` setting (one
-- "YYYY-MM-DD percent" line per rate change) instead of the single
-- `invoice.vatRateBp`. Backfill: a deployment that had saved a (positive)
-- `invoice.vatRateBp` gets the equivalent one-line schedule, dated at the
-- start of the current RO regime (every order this app took postdates it,
-- and issuance falls back to the earliest entry before it anyway). The old
-- row is left in place — unknown keys are ignored by the registry — so the
-- migration stays additive; a zero rate is not migrated (it would fail the
-- schedule validator; the operator saves the schedule at /admin/settings).
INSERT INTO "site_settings" ("key", "value", "updated_at", "updated_by")
SELECT
	'invoice.vatStandardRates',
	to_jsonb(
		'2025-08-01 ' ||
		rtrim(rtrim(to_char((("value" #>> '{}')::numeric) / 100, 'FM9990.00'), '0'), '.')
	),
	"updated_at",
	"updated_by"
FROM "site_settings"
WHERE "key" = 'invoice.vatRateBp'
	AND jsonb_typeof("value") = 'number'
	AND ("value" #>> '{}')::numeric > 0
ON CONFLICT ("key") DO NOTHING;
