# Phase 5 — Shop: products, cart, Stripe Checkout, orders

## Objective

A working shop: pillar-tagged products managed in admin, a cart, Stripe
Checkout (test mode) with webhook-driven order creation, and order visibility
in admin. Invoicing/shipping integrations are OUT of scope (later phase, prod
only).

## Deliverables

1. **`modules/shop` schema**: `products` — id, slug, name, description_md,
   price_cents, currency (`ron`), stripe_product_id, stripe_price_id, status
   (`draft`|`active`|`archived`), cover_media_id, gallery (jsonb media ids),
   stock (nullable int; null = untracked), timestamps; `product_pillars`;
   `orders` — id, email, stripe_session_id (unique), stripe_payment_intent,
   amount_total_cents, currency, status (`pending`|`paid`|`failed`|`refunded`),
   shipping_address (jsonb), created_at; `order_items` — order_id, product_id,
   name+price snapshot, qty. Migrations committed.
2. **Stripe sync**: on product create/update in admin, upsert Stripe product +
   price (archive replaced prices). Behind a `StripeGateway` interface so tests
   inject a mock.
3. **Cart**: cookie/session-based (no login needed), `modules/shop` service +
   header widget (count), `/cos` (cart page: qty edit, remove, totals).
4. **Checkout**: server action creates a Stripe Checkout Session (line items
   from cart, `RON`, collect shipping address, success/cancel URLs from
   `PUBLIC_SITE_URL`) → redirect. Success page clears cart, shows order summary
   by session id (retrieved server-side).
5. **Webhook** `/api/stripe/webhook`: signature-verified;
   `checkout.session.completed` → create order + items (idempotent on
   session id), decrement tracked stock, send order-confirmation email (new
   template through `modules/email`); `charge.refunded` → mark refunded.
6. **Public routes**: `/magazin` (grid, filter by the active site's pillars),
   `/magazin/[slug]` (product page, gallery via `<Img>`, add to cart). Only
   `active` products visible; out-of-stock (tracked, 0) shows disabled buy.
7. **Admin**: `/admin/products` (CRUD, media pickers, pillar multi-select,
   stripe sync status), `/admin/orders` (list, detail, status; read-only).
   Products/orders admin-role only (editors excluded) per Phase 1 rules.
8. **Seed**: 3 demo products (sleep pillar) with placeholder images.

## Steps

1. Schema + StripeGateway interface + mock; product services + admin CRUD.
2. Cart + public catalog pages.
3. Checkout session creation + success page (mocked gateway in tests).
4. Webhook with signature verification (use stripe SDK's signing helper to
   construct valid test events) + order creation + email.

## Tests

- Unit: cart math (qty, totals), stock decrement floor at 0, order idempotency
  on duplicate webhook delivery, product visibility rules.
- Integration: webhook happy path — signed `checkout.session.completed` fixture
  → order + items + email_log row; tampered signature → 400, no order;
  duplicate event → still exactly one order.
- E2E (mock gateway): browse seeded catalog, add 2 items, edit qty in cart,
  reach the point of checkout-session creation (assert redirect URL produced);
  simulate webhook → order appears in admin with correct totals.

## Definition of Done

- [ ] Gate green; e2e above green with the mocked gateway (no live Stripe
      calls in any test).
- [ ] Manual-verification path documented in STATE.md: how to run with real
      `sk_test_…` keys + `stripe listen` for a human end-to-end test (do NOT
      perform it yourself if keys are absent — this is not a blocker).
- [ ] Money handled in integer cents everywhere; no floats (grep-verified).
- [ ] Products tagged to inactive pillars are excluded per site (test exists).
- [ ] `docs/STATE.md` updated; all work committed.
