CREATE TABLE "pillars" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pillars_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pillars_slug_unique" UNIQUE("slug")
);
