CREATE TABLE "media" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'image' NOT NULL,
	"key" text,
	"filename" text,
	"mime" text,
	"size" integer,
	"width" integer,
	"height" integer,
	"alt" text DEFAULT '' NOT NULL,
	"blurhash" text,
	"video_provider" text,
	"video_external_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_key_unique" UNIQUE("key"),
	CONSTRAINT "media_kind_shape" CHECK (("media"."kind" = 'image' and "media"."key" is not null and "media"."filename" is not null and "media"."mime" is not null and "media"."size" is not null)
			or ("media"."kind" = 'video-embed' and "media"."video_provider" is not null and "media"."video_external_id" is not null and "media"."key" is null))
);
--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_created_at_idx" ON "media" USING btree ("created_at");