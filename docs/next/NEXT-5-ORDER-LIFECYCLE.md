# NEXT-5 — Order lifecycle: event ledger, fulfillment states, admin transitions

Context: `docs/STATE.md` § FIX-6 ("Deliberately deferred — L6": Stripe `processed_events`
ledger), `modules/shop/webhook.ts`, `modules/shop/schema.ts`.

## Problem

Two gaps that both invoicing (NEXT-6/7) and shipping (NEXT-8) sit on top of:

- **No event ledger.** Webhook idempotency rests entirely on the UNIQUE
  `stripe_session_id` for `checkout.session.completed`. That covers exactly one event type.
  `charge.refunded` has no such anchor — a redelivery re-runs it, and every event type
  added later (invoice issuance, shipping notification) has none either. Audit L6 named
  this and it was deferred; the phases after this one make it load-bearing.
- **Orders have no fulfillment dimension.** `status` is payment-only
  (`pending|paid|failed|refunded`). There is no way to express "paid, not yet packed",
  "shipped, AWB 1234", "delivered", "returned" — so shipping has nothing to write to and
  the operator has no work queue.

## Deliverables

1. **`processed_events` table** (order-independent, keyed on the provider event id) written
   inside the same transaction as the effect it guards. A redelivered event of ANY type is
   detected and acknowledged without repeating the effect. Include the provider, event
   type, received-at, and the outcome recorded for it, so `/admin/orders` can show why an
   event did nothing. Add a retention entry to the existing sweep
   (`server/retention.ts`) so it does not grow forever — old ledger rows expire well after
   any plausible Stripe redelivery window; document the number you chose.
2. **`fulfillment_status`** on orders — a separate column from payment `status`, with an
   explicit state machine (suggested: `unfulfilled → packed → shipped → delivered`, plus
   `returned` and `cancelled`) and a service that is the ONLY writer. Illegal transitions
   are rejected with a typed error, not silently ignored. Backfill existing rows in the
   migration.
3. **Order events / audit trail**: an append-only per-order history (who or what changed
   the state, when, free-text note) so the operator can answer "what happened to this
   order" — invoices and AWBs will hook into it in the following phases.
4. **Admin work queue**: `/admin/orders` gains filtering by fulfillment status (default
   view = what needs action), and `/admin/orders/[id]` gains the legal transitions as
   actions with a note field. Admin-role only; every transition writes an order event.
   Keep the existing read-only detail intact.
5. **The oversold flag becomes actionable** — it already exists and nothing consumes it.
   Surface oversold orders in the work queue.

## Tests

- Integration: the same `charge.refunded` event delivered twice marks the order refunded
  once, and the second delivery reports the ledger hit — this test must fail on the
  current code.
- Integration: ledger write and effect are atomic — force the effect to throw and assert
  neither the ledger row nor the effect survived (so a poisoned event can be retried).
- Integration: retention sweep removes expired ledger rows and keeps fresh ones.
- Unit: state machine — every legal transition allowed, a table of illegal ones rejected;
  the service is the only writer (a test asserting direct writes are not used elsewhere).
- Integration: admin transition action writes the state + an order event; editor role 403.
- Integration: work-queue filter returns the right orders, including oversold ones.

## Definition of Done

- [ ] Gate green; `pnpm db:migrate` clean on a fresh AND on a populated database
      (backfill verified on a DB seeded with pre-migration orders).
- [ ] Duplicate delivery of every handled event type is provably a no-op.
- [ ] `fulfillment_status` has exactly one writer and a tested state machine.
- [ ] `/admin/orders` is usable as a daily work queue.
- [ ] STATE.md updated (including the ledger retention window); work committed.
