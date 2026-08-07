CREATE TABLE "nurture_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"sequence_id" text NOT NULL,
	"subscriber_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "nurture_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"enrollment_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "nurture_sequences" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"trigger" jsonb NOT NULL,
	"consent_key" text DEFAULT 'newsletter' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nurture_sequences_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "nurture_enrollments" ADD CONSTRAINT "nurture_enrollments_sequence_id_nurture_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."nurture_sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nurture_enrollments" ADD CONSTRAINT "nurture_enrollments_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nurture_sends" ADD CONSTRAINT "nurture_sends_enrollment_id_nurture_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."nurture_enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nurture_enrollments_sequence_subscriber_uq" ON "nurture_enrollments" USING btree ("sequence_id","subscriber_id");--> statement-breakpoint
CREATE INDEX "nurture_enrollments_subscriber_id_idx" ON "nurture_enrollments" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "nurture_enrollments_status_closed_at_idx" ON "nurture_enrollments" USING btree ("status","closed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "nurture_sends_enrollment_step_uq" ON "nurture_sends" USING btree ("enrollment_id","step_index");--> statement-breakpoint
CREATE INDEX "nurture_sends_status_scheduled_at_idx" ON "nurture_sends" USING btree ("status","scheduled_at");