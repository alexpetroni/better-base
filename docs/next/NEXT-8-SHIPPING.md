# NEXT-8 — Shipping: cost at checkout, courier seam, AWB, tracking emails

Context: `docs/STATE.md` § "Known gaps" (no shipping-provider integration: AWB, tracking
emails). Depends on NEXT-3 (shop settings), NEXT-5 (fulfillment states, order events).

## Problem

Checkout collects a Romanian shipping address and charges the product total — shipping is
free by accident, not by decision. After payment nothing exists: no AWB, no tracking
number, no notification, and the operator's only tool is the read-only order detail. For a
physical-goods shop in Romania this is the last functional gap before launch.

## Deliverables

1. **Shipping cost is a real, configured decision.** Shipping options come from settings /
   site config (name, price in bani, free-above threshold, estimated delivery), are shown
   in the cart before checkout, are passed to Stripe Checkout as `shipping_options`, and
   land on the order as a distinct amount — separate from the goods total, because the
   invoice (NEXT-6/7) must show shipping as its own VAT-bearing line. Update the invoice
   line construction accordingly; the invoice total must equal what Stripe charged, and a
   test must assert that equality.
2. **`CourierProvider` interface + deterministic mock**, following `StripeGateway`:
   `createShipment(order) → { awb, labelUrl?, trackingUrl }`, `trackShipment(awb) → status`,
   `cancelShipment(awb)`. The real adapter (Sameday or Cargus — pick one, justify briefly,
   and keep the interface provider-agnostic) is selected only when its credentials are
   present; dev, vitest and e2e always run the mock. Never call a courier API in tests.
3. **AWB generation from admin**: a "generate AWB" action on `/admin/orders/[id]` for a
   paid order, moving fulfillment to `shipped` through the NEXT-5 state machine, storing
   awb/tracking/label references, and writing an order event. Idempotent — pressing it
   twice does not create two shipments. Label retrieval goes through the same authenticated,
   signed-URL pattern as invoice documents.
4. **Customer tracking emails**: a shipping-notification template (typed, in
   `modules/email/templates.ts`) sent once per shipment with an idempotency key derived
   from the AWB, honoring `EMAIL_DRYRUN`. A delivered-status email is optional — only if
   status polling (below) lands cleanly.
5. **Status sync via cron**: extend the existing cron seam (`src/routes/api/cron/…`, guarded
   by `authorizeCron()`) with a shipment-status poll for in-flight AWBs, updating
   fulfillment state and writing order events. It must be safe to run twice, bounded in how
   many shipments it touches per invocation (serverless time limits), and a no-op when the
   provider is the mock with nothing in flight. Register the schedule in `vercel.json` AND
   document the machine-cron equivalent in `DEPLOYMENT.md` §9.
6. **Returns/refund interaction**: a refunded order's fulfillment state and any pending
   shipment are handled coherently (cancel if not yet shipped, mark `returned` otherwise) —
   define the rule and test it.

## Tests

- Unit: shipping-cost selection — under and over the free threshold, multiple options,
  a settings-driven change taking effect without a code change.
- Integration: checkout → webhook → order carries goods total, shipping amount and grand
  total consistently; invoice grand total equals the Stripe amount (regression anchor).
- Unit: mock courier is selected without credentials; the real adapter never constructs in
  tests.
- Integration: AWB action is idempotent, transitions state legally, writes an order event,
  and 403s for the editor role.
- Integration: shipping email sent once per AWB under a repeated action (dry-run capture).
- Integration: cron poll updates statuses, is idempotent, respects its per-run bound, and
  returns 401/503 under the existing cron-auth rules.
- Integration: refund-before-shipment cancels; refund-after-shipment marks returned.
- E2E: purchase (mock gateway) with a shipping option selected → admin generates AWB →
  order shows shipped with a tracking link.

## Definition of Done

- [ ] Gate green; e2e green.
- [ ] Shipping is priced, charged, invoiced and reconciled — totals provably consistent.
- [ ] Courier behind an interface with a mock; no test can reach a courier API.
- [ ] AWB + tracking email + status sync all idempotent.
- [ ] `vercel.json` schedule and `DEPLOYMENT.md` §9 both updated; `LAUNCH-CHECKLIST.md`
      gains the courier-account human steps.
- [ ] STATE.md updated; work committed.
