# FIX-10 — Money after the first payment: refunds, async payments, stock

Audit refs: P0 #2, P0 #3; P1 "Shop & shipping" (pending orders, quantity vs stock); P2
shop edges (absolute stock write, empty-cart sessions, shipping settings length). See
`docs/AUDIT-2026-09-03.md`.

## Problem

`handleChargeRefunded` (`modules/shop/webhook.ts:340-405`) never reads
`charge.amount_refunded`: a partial refund marks the order refunded, issues a storno of
the whole invoice and cancels fulfillment or the AWB — and the oversell comment recommends
exactly this workflow. An unmatched refund is committed to the ledger with a 200, so a
refund that arrives before its `checkout.session.completed` is lost and the order is later
created paid, invoiced, emailed and shipped. Unpaid sessions become `pending` orders that
still consume stock and get a confirmation email, and no handler exists for the async
payment events. Cart quantity is never compared with stock. Admin stock edits are absolute
writes racing the webhook decrement.

## Deliverables

1. **Refund model.** `orders.refunded_cents` (new migration, backfilled from status).
   `handleChargeRefunded` branches on `charge.amount_refunded < charge.amount`:
   - partial → `refund-partial` order event with the amount, `refunded_cents` updated,
     status stays `paid`, fulfillment/shipment untouched, NO automatic storno; the order
     shows in the work queue with a "refund partial" badge;
   - full → today's path.
   An admin action **"storno parțial"** on `/admin/orders/[id]` issues a storno whose gross
   equals the refunded amount (single negative line referencing the original, VAT extracted
   at the original line rate) through the invoice module; replace the one-storno-per-invoice
   unique index with a check that Σ storno gross ≤ original gross (migration).
2. **Refund-before-order.** A `pending_refunds` table keyed by payment intent (charge id,
   amount, received at). Unmatched refunds are recorded there inside `runOnce` (still
   exactly-once). `createOrderFromSession` consults it: a pending full refund → the order is
   created `refunded` with invoice + storno and no confirmation email / nurture enrollment;
   a pending partial refund → created `paid` with `refunded_cents` set and the event on the
   trail. Retention sweep prunes matched rows after the ledger window.
3. **Async payments.** Handle `checkout.session.async_payment_succeeded` (flip
   `pending → paid`, issue the invoice, then email + nurture, all in the `runOnce` shape) and
   `checkout.session.async_payment_failed` (status `failed`, restore stock, fulfillment
   `cancelled`, event). Never send the confirmation email for a `pending` order. Document
   the two extra events in DEPLOYMENT.md §7. Additionally pin
   `payment_method_types: ['card']` on the session unless a setting enables more — the
   operator decides in `/admin/settings`, default card-only.
4. **Quantity vs stock.** `loadCartDetails` computes `available` including
   `qty <= stock` (null stock = untracked) and exposes `maxQty`; the cart actions clamp to
   it; `createCheckoutFromCart` refuses with an `unavailable` detail naming the available
   count. `/cos` shows the cap.
5. **Stock edits.** The product form gains a relative "adaugă N bucăți" restock field
   (`stock = stock + delta` in SQL) and the absolute field becomes an optimistic write
   (`WHERE stock = <loaded>` → typed `stock-changed` error shown in the form).
6. **Small guards.** A completed session without a `cart` snapshot logs at error level with
   session id and amount and appears in the admin as an `empty-cart` ledger row; the
   shipping display name / ETA settings get `maxLength` (60/40) in the registry validator.

## Tests

- **Integration (must FAIL on current code):** a `charge.refunded` with
  `amount_refunded < amount` leaves the order `paid`, issues no storno, does not touch
  fulfillment, records the amount; a full refund still does today's path.
- Integration: refund event delivered BEFORE the session event → the order is created
  already refunded, no email, no nurture; the reverse order still works; both exactly-once.
- Integration: `async_payment_succeeded` flips pending → paid once, issues one invoice,
  sends one email; `async_payment_failed` restores stock and cancels; a `pending` order
  never triggers `sendOrderConfirmation`.
- Integration: stock 1, qty 5 → cart line unavailable with `maxQty 1`; checkout refuses.
- Integration (racing): admin absolute stock save concurrent with a webhook decrement →
  `stock-changed`, no phantom unit; relative restock adds exactly N.
- Unit: partial storno amounts (gross/VAT split at the original rate, integer bani).

## Definition of Done

- [ ] Gate green; partial-refund and refund-before-order regressions pass, each added in a test-first commit that precedes its fix in `git log`.
- [ ] Every handled Stripe event type is exactly-once in both delivery orders.
- [ ] `pnpm db:migrate` clean on fresh and populated DBs (backfill of `refunded_cents`).
- [ ] DEPLOYMENT.md §7 lists the four subscribed events and the card-only default.
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
