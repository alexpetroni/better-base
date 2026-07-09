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
  session id; `charge.refunded` flips the matching order to `refunded`.
  Order confirmation email is keyed `order-confirmation:<orderId>`.
- Public visibility rule (like blog/quiz): product is `active` AND tagged to
  a pillar in the active site's config.
