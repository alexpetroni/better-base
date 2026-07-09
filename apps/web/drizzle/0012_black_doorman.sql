ALTER TABLE "quiz_results" ADD COLUMN "client_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "quiz_results_quiz_id_client_token_uq" ON "quiz_results" USING btree ("quiz_id","client_token");