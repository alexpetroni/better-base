# FIX-2 — Transactional writes (Theme B)

Audit ref: Theme B (resilience #1, HIGH). See `docs/AUDIT-2026-07-09.md`.

## Problem

No `db.transaction()` exists anywhere. Order creation
(`shop/webhook.ts:83-142`) writes the order row, order_items, per-product stock
decrement, and email as independent awaits. If anything after the order insert throws, the
order has already claimed `stripeSessionId`, so Stripe redelivery hits
`onConflictDoNothing` → "duplicate" → nothing happens. Result: customer charged, order has
zero line items, stock not decremented, no email — permanently unrecoverable.

## Deliverables

1. Wrap order + order_items + stock decrement in a single `db.transaction()` so they
   commit atomically or not at all. The `stripeSessionId` uniqueness claim must be inside
   the same transaction as the items/stock, so a failure rolls back the claim and Stripe's
   redelivery genuinely retries the whole unit.
2. Move the confirmation email send to AFTER the transaction commits (it is already
   idempotent), so a mail failure cannot roll back a paid order, and a retried webhook
   re-sends only if not already sent.
3. Audit for any other multi-write invariant that should be atomic (e.g. quiz submit
   writing result + subscriber + consent; pillar validate+replace; media confirm) and wrap
   the ones where a partial write is corrupting. Document any deliberately left
   non-transactional and why.

## Tests

- **Integration (test DB): simulate a failure of the order_items insert (or stock update)
  after the order row — assert NOTHING is committed (no order, no items, no stock change),
  and that a subsequent successful redelivery of the same event creates the complete
  order exactly once.** Must fail against current code (which leaves a headless order).
- Integration: duplicate + concurrent delivery still yields exactly one complete order.
- Integration: a failing email send does not roll back or duplicate the order.

## Definition of Done

- [ ] Gate green; the partial-failure regression test passes and failed before.
- [ ] Order creation is all-or-nothing; email is post-commit and idempotent.
- [ ] Other genuinely-atomic invariants wrapped or explicitly documented.
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
