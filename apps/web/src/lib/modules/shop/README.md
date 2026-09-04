# modules/shop

Products, cart, Stripe Checkout and orders (Phase 5).

- **Money is integer cents (bani) everywhere.** `money.ts` is the only place
  amounts become strings (`formatCents`) or are parsed from admin input
  (`parseLeiToCents`) — both on integer/string math, no floats.
- **Cart** is a plain cookie of `{ productId, qty }` lines (`cart.ts`, pure).
  Prices always come from the database, so a tampered cookie cannot change
  what is charged. Max 7 distinct lines (the checkout snapshot must fit in a
  500-char Stripe metadata value).
- **StripeGateway** (`gateway.ts`) abstracts every Stripe API call. The real
  implementation (`stripe-gateway.ts`) is selected ONLY when
  `STRIPE_SECRET_KEY` is set; otherwise the deterministic in-memory mock
  (`mock-gateway.ts`) runs — dev and all tests use the mock, so no test can
  ever call Stripe.
- **Sync** (`sync.ts`): admin saves mirror the product into Stripe (product
  upsert; new price + archive of the replaced one when the amount changed).
  Checkout does NOT depend on sync: sessions use inline `price_data`
  snapshotted from our DB.
- **Checkout** (`checkout.ts`): session per cart, `RON`, shipping collected
  for RO, success/cancel URLs from `PUBLIC_SITE_URL`. The paid snapshot
  travels in session metadata (`cart` = `[{i,q,p}]`).
- **Webhook** (`webhook.ts`): `verifyStripeEvent` (SDK signature check,
  offline) + `processStripeEvent`. Orders are idempotent on the unique
  session id and every handled event is exactly-once via the
  `processed_events` ledger. Order confirmation email is keyed
  `order-confirmation:<orderId>` and goes out ONLY for a `paid` order.
- **Refunds** (FIX-10): `charge.refunded` carries `amount` and the
  CUMULATIVE `amount_refunded`. Partial (`amount_refunded < amount`) → the
  order stays `paid`, `orders.refunded_cents` records the amount, a
  `refund-partial` event lands on the trail, nothing else moves (no storno,
  fulfillment/AWB untouched — the customer keeps the goods); the operator
  issues the fiscal reversal with "storno parțial" on the order page. Full →
  status `refunded`, storno of the whole invoice (or of the remainder after
  partial stornos), fulfillment/AWB per the NEXT-8 rule. A refund with NO
  order yet is remembered in `pending_refunds` (keyed by payment intent) and
  consumed at order creation: full → the order is created `refunded` with
  invoice + storno and no email/nurture/stock; partial → created `paid` with
  `refunded_cents` set. Handlers for one payment intent serialize on a
  transaction-scoped advisory lock, so the two events may arrive in either
  order or concurrently. Matched pending rows are pruned by the retention
  sweep after the ledger window; unmatched ones surface in `/admin/orders`.
- **Async payments**: `checkout.session.async_payment_succeeded` flips a
  `pending` order to `paid` (invoice, email, nurture — or creates it paid if
  it arrives first); `checkout.session.async_payment_failed` marks it
  `failed`, restores the reserved stock (unless the order was oversold — the
  clamp lost the exact count; the trail says so) and cancels fulfillment.
  Sessions are created card-only unless `shop.allowAllPaymentMethods` is on.
- **Shipping (NEXT-8 + FIX-11)**: `CourierProvider` seam (`courier.ts`;
  mock default, Sameday behind `COURIER_PROVIDER=sameday`). Checkout collects
  the recipient phone; `createShipmentForOrder` refuses with a typed
  `missing-recipient-data` (phone/county/city/line1) BEFORE any courier call
  and the admin fills the address in (`updateOrderShippingAddress`, trail
  names the changed fields only). AWB creation is two-phase: a `creating`
  claim row committed under the order lock → courier call with no lock held
  (`clientInternalReference` = order id) → `registered` + fulfillment walk,
  or `failed` with the courier's reason (retry = fresh claim; a claim older
  than 5 min is failed and replaced; a refund mid-call cancels the fresh
  AWB). One LIVE row per order (partial unique index; cancelled/failed rows
  may be replaced). The hourly sync polls only DUE rows, backs a throwing
  row off (15 min doubling, 24 h cap, `error_count`/`last_error`,
  `shipment-sync-error` event), aborts the run on `CourierAuthError`
  (`aborted: 'auth'`), and on a courier-side `cancelled` closes the row and
  steps the order `shipped → packed` — an edge only `SHIPMENT_SYNC_ACTOR`
  may take. Sameday statuses classify by `SAMEDAY_STATUS_BY_ID` (maintained
  from captured fixtures), then anchored text rules with explicit negatives
  (`nelivrat` ≠ `livrat`), unknown text → warn + in-transit.
- Public visibility rule (like blog/quiz): product is `active` AND tagged to
  a pillar in the active site's config.
