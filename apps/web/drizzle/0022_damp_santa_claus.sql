CREATE TABLE "pending_refunds" (
	"payment_intent" text PRIMARY KEY NOT NULL,
	"charge_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"amount_refunded_cents" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"matched_at" timestamp with time zone,
	"order_id" text
);
--> statement-breakpoint
DROP INDEX "invoices_storno_of_uq";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "refunded_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_refunds" ADD CONSTRAINT "pending_refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_refunds_matched_at_idx" ON "pending_refunds" USING btree ("matched_at");--> statement-breakpoint
CREATE INDEX "invoices_storno_of_idx" ON "invoices" USING btree ("storno_of_invoice_id");--> statement-breakpoint
-- Backfill (audit 2026-09-03 P0 #2): before this column existed the webhook
-- could only record FULL refunds, so every refunded order was refunded in
-- whole. Orders refunded from here on carry Stripe's cumulative amount.
UPDATE "orders" SET "refunded_cents" = "amount_total_cents" WHERE "status" = 'refunded';--> statement-breakpoint
-- Stornos may be PARTIAL from now on (a partial refund reverses only the
-- refunded amount), so the one-storno-per-invoice unique index above is
-- replaced by the rule that actually matters: the stornos of an invoice may
-- never reverse more than the invoice itself. A CHECK cannot span rows, so
-- the bound is a BEFORE INSERT trigger; the service additionally locks the
-- original row so concurrent partial stornos serialize on it.
CREATE FUNCTION invoices_storno_within_original() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	original_gross integer;
	already_reversed integer;
BEGIN
	IF NEW.kind <> 'storno' THEN
		IF NEW.storno_of_invoice_id IS NOT NULL THEN
			RAISE EXCEPTION 'only a storno may reference the invoice it reverses (%)', NEW.display_number;
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.storno_of_invoice_id IS NULL THEN
		RAISE EXCEPTION 'a storno must reference the invoice it reverses (%)', NEW.display_number;
	END IF;
	SELECT gross_total_cents INTO original_gross
		FROM invoices WHERE id = NEW.storno_of_invoice_id AND kind = 'invoice';
	IF original_gross IS NULL THEN
		RAISE EXCEPTION 'a storno must reference an invoice, not another storno (%)', NEW.display_number;
	END IF;
	IF NEW.gross_total_cents > 0 THEN
		RAISE EXCEPTION 'a storno reverses: its gross must not be positive (%)', NEW.display_number;
	END IF;
	SELECT COALESCE(SUM(-gross_total_cents), 0) INTO already_reversed
		FROM invoices WHERE storno_of_invoice_id = NEW.storno_of_invoice_id;
	IF already_reversed - NEW.gross_total_cents > original_gross THEN
		RAISE EXCEPTION 'storno total exceeds the original invoice: % already reversed + % requested > % gross (%)',
			already_reversed, -NEW.gross_total_cents, original_gross, NEW.display_number;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER invoices_storno_bounded
BEFORE INSERT ON "invoices"
FOR EACH ROW EXECUTE FUNCTION invoices_storno_within_original();
