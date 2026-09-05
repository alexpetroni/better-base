ALTER TABLE "email_log" ADD COLUMN "headers" jsonb;--> statement-breakpoint
ALTER TABLE "nurture_sends" ADD COLUMN "steps_hash" text;