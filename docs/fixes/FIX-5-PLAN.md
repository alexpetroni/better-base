# FIX-5 — Data integrity: FK indexes, media references, email uniqueness, idempotency (Theme E + data-model)

Audit refs: Theme E (data-model HIGH-2, MED-1), data-model HIGH-3, LOW-2; resilience #6,
#7, #8. See `docs/AUDIT-2026-07-09.md`.

## Problem

Postgres does not auto-index FKs, so real paths seq-scan. Media referenced from
`products.gallery` (jsonb) and inline `media:` markdown has no referential integrity.
Email uniqueness is case-sensitive and relies on the app lowercasing. Quiz submit is not
idempotent. The `chat_rate_limits` table grows unbounded (prune only deletes sessions).

## Deliverables

1. **One additive migration adding covering indexes** on every unindexed FK / lookup
   column: `quizzes.pillar_id`, `quiz_results.subscriber_id`, `orders.email`,
   `orders.stripe_payment_intent`, `order_items.product_id`, `articles.cover_media_id`,
   `products.cover_media_id`, `articles.created_by`, `quizzes.created_by`,
   `media.created_by`. Verify it runs cleanly on a fresh AND populated DB.
2. **Media reference integrity on delete**: extend the media delete path to scan for
   references in `products.gallery` (`@> [id]`) and in markdown bodies (`body_md`/
   `description_md` `LIKE '%media:<id>%'`) in addition to the existing cover FK check, and
   block deletion (or report the referencing rows) so galleries/markdown can't dangle.
3. **Case-insensitive email uniqueness**: use `citext` or a `LOWER(email)` functional
   unique index on `subscribers.email` and `users.email` so a bypassing writer can't
   create `A@x.com` + `a@x.com`. (Keep `normalizeEmail` too.)
4. **Quiz submission idempotency**: derive an idempotency key (per-attempt client token or
   hash of quiz+answers+session) and `onConflictDoNothing`, so a double-submit/refresh
   doesn't create duplicate `quiz_results` rows.
5. **Prune unbounded rate-limit rows**: in the chat prune cron/script, also delete
   `chat_rate_limits` rows whose window is older than the retention window.
6. Overselling (resilience #7): either add a stock reservation/hold at checkout or detect
   oversell in the order transaction (from FIX-2) and flag/refund; if you judge reservation
   too heavy for now, document it as an accepted tradeoff with the exact reasoning.

## Tests

- Integration: deleting a media row referenced by a product gallery or by article markdown
  is blocked/reported (fails today — dangles).
- Integration: inserting `A@x.com` then `a@x.com` violates uniqueness at the DB level.
- Integration: double quiz-submit creates exactly one result row.
- Integration: prune removes expired rate-limit rows.
- A test or query-plan assertion demonstrating the new indexes are used for the hot
  lookups (or at least present) — and the migration applies on a populated DB.

## Definition of Done

- [ ] Gate green + `pnpm db:migrate` clean on fresh and populated DB.
- [ ] All listed indexes exist; media refs can't dangle; email uniqueness is
      case-insensitive; quiz submit idempotent; rate-limit rows pruned.
- [ ] Overselling fixed or explicitly documented as accepted.
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
