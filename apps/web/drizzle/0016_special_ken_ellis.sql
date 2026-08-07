CREATE TABLE "invoice_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"vat_rate_bp" integer NOT NULL,
	"net_cents" integer NOT NULL,
	"vat_cents" integer NOT NULL,
	"gross_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_series" (
	"series" text PRIMARY KEY NOT NULL,
	"next_number" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"series" text NOT NULL,
	"number" integer NOT NULL,
	"display_number" text NOT NULL,
	"order_id" text,
	"storno_of_invoice_id" text,
	"issued_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"issuer_name" text NOT NULL,
	"issuer_cui" text NOT NULL,
	"issuer_vat_registered" boolean NOT NULL,
	"issuer_reg_com" text NOT NULL,
	"issuer_address" text NOT NULL,
	"issuer_place" text DEFAULT '' NOT NULL,
	"issuer_email" text DEFAULT '' NOT NULL,
	"issuer_phone" text DEFAULT '' NOT NULL,
	"issuer_iban" text DEFAULT '' NOT NULL,
	"issuer_bank" text DEFAULT '' NOT NULL,
	"buyer_name" text NOT NULL,
	"buyer_email" text DEFAULT '' NOT NULL,
	"buyer_address" text DEFAULT '' NOT NULL,
	"buyer_company_name" text,
	"buyer_company_cui" text,
	"buyer_company_reg_com" text,
	"net_total_cents" integer NOT NULL,
	"vat_total_cents" integer NOT NULL,
	"gross_total_cents" integer NOT NULL,
	"mentions" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "billing_company" jsonb;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_storno_of_invoice_id_invoices_id_fk" FOREIGN KEY ("storno_of_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_series_number_uq" ON "invoices" USING btree ("series","number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_order_invoice_uq" ON "invoices" USING btree ("order_id") WHERE "invoices"."kind" = 'invoice';--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_storno_of_uq" ON "invoices" USING btree ("storno_of_invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_order_id_idx" ON "invoices" USING btree ("order_id");--> statement-breakpoint
-- Invoices are legal documents: append-only at the DATABASE level, not just
-- by service convention. Corrections are new documents (storno) — an UPDATE
-- or DELETE on an issued invoice or its lines must never succeed, whatever
-- code path (or human with a psql prompt) attempts it. TRUNCATE is left
-- possible on purpose: it is a table-maintenance operation used by the test
-- harness, not a row-mutation path.
CREATE FUNCTION invoices_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'invoices are append-only: corrections are issued as storno documents, never edits (%.%)', TG_TABLE_NAME, TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER invoices_immutable
BEFORE UPDATE OR DELETE ON "invoices"
FOR EACH ROW EXECUTE FUNCTION invoices_forbid_mutation();--> statement-breakpoint
CREATE TRIGGER invoice_lines_immutable
BEFORE UPDATE OR DELETE ON "invoice_lines"
FOR EACH ROW EXECUTE FUNCTION invoices_forbid_mutation();
