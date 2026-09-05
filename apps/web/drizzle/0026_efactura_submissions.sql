CREATE TABLE "invoice_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"anaf_index" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_submissions" ADD CONSTRAINT "invoice_submissions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_submissions_invoice_uq" ON "invoice_submissions" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_submissions_status_idx" ON "invoice_submissions" USING btree ("status","next_attempt_at");--> statement-breakpoint
-- FIX-12 backfill: a document issued before the queue existed has no record
-- of reaching ANAF, so it is queued as pending (the admin "de trimis la ANAF"
-- filter shows it with its days left). One row per invoice/storno; idempotent.
INSERT INTO "invoice_submissions" ("id", "invoice_id", "status", "created_at", "updated_at")
SELECT gen_random_uuid()::text, i."id", 'pending', i."issued_at", now()
FROM "invoices" i
WHERE NOT EXISTS (SELECT 1 FROM "invoice_submissions" s WHERE s."invoice_id" = i."id");
