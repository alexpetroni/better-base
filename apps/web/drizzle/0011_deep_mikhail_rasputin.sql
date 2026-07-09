CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "articles_cover_media_id_idx" ON "articles" USING btree ("cover_media_id");--> statement-breakpoint
CREATE INDEX "articles_created_by_idx" ON "articles" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "subscribers_email_lower_uq" ON "subscribers" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "media_created_by_idx" ON "media" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "quiz_results_subscriber_id_idx" ON "quiz_results" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "quizzes_pillar_id_idx" ON "quizzes" USING btree ("pillar_id");--> statement-breakpoint
CREATE INDEX "quizzes_created_by_idx" ON "quizzes" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "order_items_product_id_idx" ON "order_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "orders_email_idx" ON "orders" USING btree ("email");--> statement-breakpoint
CREATE INDEX "orders_stripe_payment_intent_idx" ON "orders" USING btree ("stripe_payment_intent");--> statement-breakpoint
CREATE INDEX "products_cover_media_id_idx" ON "products" USING btree ("cover_media_id");