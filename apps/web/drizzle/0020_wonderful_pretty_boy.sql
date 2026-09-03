CREATE TABLE "admin_audit" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "admin_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "admin_audit_at_idx" ON "admin_audit" USING btree ("at");--> statement-breakpoint
-- The staff action log is append-only at the DATABASE level, mirroring the
-- fiscal tables (0016): an UPDATE or DELETE must never succeed, whatever
-- code path (or compromised admin session at a psql prompt) attempts it.
-- TRUNCATE stays possible on purpose — table maintenance for test harnesses,
-- not a row-mutation path.
CREATE FUNCTION admin_audit_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'admin_audit is append-only (%.%)', TG_TABLE_NAME, TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER admin_audit_immutable
BEFORE UPDATE OR DELETE ON "admin_audit"
FOR EACH ROW EXECUTE FUNCTION admin_audit_forbid_mutation();
