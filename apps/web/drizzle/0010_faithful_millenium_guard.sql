CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"prev_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "login_attempts" ADD COLUMN "prev_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_rate_limits" ADD COLUMN "prev_count" integer DEFAULT 0 NOT NULL;