CREATE TABLE "quiz_results" (
	"id" text PRIMARY KEY NOT NULL,
	"quiz_id" text NOT NULL,
	"subscriber_id" text,
	"answers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" integer NOT NULL,
	"profile" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quizzes" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"intro_md" text DEFAULT '' NOT NULL,
	"pillar_id" integer,
	"form_schema" jsonb DEFAULT '{"steps":[]}'::jsonb NOT NULL,
	"scoring" jsonb DEFAULT '{"questions":{},"bands":[]}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"result_template_key" text DEFAULT 'quiz-result' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quizzes_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "quiz_results" ADD CONSTRAINT "quiz_results_quiz_id_quizzes_id_fk" FOREIGN KEY ("quiz_id") REFERENCES "public"."quizzes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_results" ADD CONSTRAINT "quiz_results_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_pillar_id_pillars_id_fk" FOREIGN KEY ("pillar_id") REFERENCES "public"."pillars"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quizzes" ADD CONSTRAINT "quizzes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quiz_results_quiz_id_created_at_idx" ON "quiz_results" USING btree ("quiz_id","created_at");