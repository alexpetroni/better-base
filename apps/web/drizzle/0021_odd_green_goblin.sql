CREATE INDEX "email_log_to_email_lower_idx" ON "email_log" USING btree (lower("to_email"));--> statement-breakpoint
CREATE INDEX "orders_email_lower_idx" ON "orders" USING btree (lower("email"));