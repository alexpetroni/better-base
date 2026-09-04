# STATE — after launch polish (2026-08-08, branch `feat/vercel-neon`)

## Launch polish: chat history restore, blurhash, launch dry run (2026-08-08, NEXT-10)

The last phase of the launch batch — closes the two remaining named gaps and
rehearses the launch procedure. No schema changes; two new pure-JS deps
(`blurhash`, `pngjs` + `@types/pngjs`); one new script.

- **Chat history restore** (`GET /api/chat`): `getChatHistory` in
  `modules/chat/service.ts` mirrors the POST path's rules — the signed cookie
  token is the ONLY authorization (malformed/foreign-secret/re-pointed tokens
  → 403; the anonymous-token equality check runs even for existing sessions),
  a pruned or unknown session yields `{messages: []}` (retention wins, no new
  session is created), and the result is bounded to the newest
  `HISTORY_RESTORE_LIMIT = 50` messages returned in chronological order
  (`ORDER BY … DESC LIMIT n` then reversed). The same sliding-window limiter
  applies via the shared core on SEPARATE keys (`history:session:` /
  `history:ip:` — `historySessionRateKey`/`historyIpRateKey`), so page
  reloads never consume the send budget; the sweep prunes those counter rows
  like any other. `ChatPanel.svelte` fetches once on mount (best-effort,
  silent on failure) and applies the snapshot ONLY while no local messages
  exist — if the visitor sent something before the fetch resolved, the
  snapshot may contain that very message, so it is discarded rather than
  merged (duplication is impossible by construction). A cookie-less visitor
  costs one pure-CPU check, no DB touch. Tests: 6 new integration cases in
  `chat.spec.ts` (order, bound incl. `limit` override, token matrix,
  restore-vs-send budget isolation, post-prune emptiness) and an e2e
  reload-restore test (two reloads, exact message counts).
- **Blurhash** (`media.blurhash` was always null since Phase 2):
  - `modules/media/blurhash.ts` (pure, offline-testable): `blurhashFromPng`
    (pngjs decode → `blurhash` encode at 4×3 components, guarded to refuse
    anything over 64×64 so a pipeline bug can never burn serverless CPU) and
    `blurhashPlaceholder` (hash → ≤32px data-URI PNG, aspect from the row's
    natural dimensions, 4:3 fallback; invalid hash → null, never a throw).
  - `computeBlurhash(imgproxy, key)` (service.ts): fetches a ≤32px PNG
    render of the stored original FROM IMGPROXY — the same pipeline every
    page view uses, so every stored raster format (jpg/png/webp/avif/gif) is
    covered by one tiny PNG decode; ~1 KB fetch + tiny encode ≈ serverless-
    cheap. `confirmUpload` computes it when the new OPTIONAL `imgproxy`
    field is in `MediaDeps` (the admin upload route passes
    `getImgproxyConfig()`); failures are non-fatal (row confirms with null),
    SVGs are skipped (served unrasterized).
  - **`pnpm media:blurhash`** (root + web script, `scripts/media-blurhash.ts`
    → `backfillBlurhashes`): fills legacy null rows; idempotent + resumable
    (null-only selection, per-row commit, failures logged + skipped, exit 1
    while any row stays unfilled). Excludes SVGs.
  - **`ImageSources.placeholder`** (string | null, REQUIRED field — object
    literals elsewhere must include it): `imageSources()` decodes the row's
    blurhash into an inline data-URI; `imgSources`/`imageSources` accept an
    optional `blurhash` on the source row (full `MediaRow` callers get it
    for free). `<Img>` paints it as the `<img>` background (SSR ships it —
    visible pre-hydration) and clears it `onload` (+`complete` check at
    hydration) so transparent images are not permanently backed by the blur.
    No blurhash → no `style` attribute → byte-identical old markup.
  - Tests: `blurhash.spec.ts` (deterministic encode on a generated fixture,
    corrupt/oversized refusal, placeholder dimensions incl. portrait + 4:3
    fallback, invalid-hash null), `img-component.spec.ts` (SSR render with/
    without placeholder), media.spec additions (confirm populates the hash;
    corrupt upload still confirms with null; backfill fills legacy rows,
    reports corrupt ones, re-run is a no-op).
- **Launch dry run executed** (2026-08-08): fresh DBs for BOTH sites →
  migrate/seed/user:create/launch:check --dev → adapter-node build → §11
  walked with curls + the admin upload API → all three cron routes curled
  (authorized 200 JSON / unauthorized 401) → full e2e (81 passed, both
  sites) → vercel build + neon suite. The record with every command and
  output is **`docs/LAUNCH-DRY-RUN.md`**; the walk found §11 predated
  invoices/shipping/analytics/cron (now steps 5–11), `media:blurhash`
  documented nowhere (now §9, §11, §12, checklist Ops), and the chat smoke
  item predating history restore (checklist updated).
- Verified: gate green (lint + check + 715 unit/integration), `pnpm
  test:neon` green, e2e 81 green across both sites, `DEPLOY_TARGET=vercel
  pnpm build` green, `pnpm db:migrate` clean on fresh DBs for both sites.

## Nurture sequences: DB-backed email queue on the cron seam (2026-08-07, NEXT-9)

The "no scheduled sending" gap is closed with the design decision the README
records first: **a database-backed queue drained by the existing guarded cron
seam** — no worker, no external scheduler, identical on adapter-node and
Vercel. Migration `0019_milky_gateway` (tables `nurture_sequences`,
`nurture_enrollments`, `nurture_sends`). No new env vars (`CRON_SECRET` now
also guards `/api/cron/nurture-send`).

- **`modules/nurture`** (new module; design record in its README — read it
  before touching scheduling/drain semantics):
  - Sequences are DATA rows: unique `key`, `trigger` jsonb
    (`consent-confirmed` | `quiz-completed` (quizSlug + optional band filter)
    | `order-paid`), `consent_key` (which marketing consent gates it), ordered
    `steps` jsonb (offsetDays, optional `hourLocal` in Europe/Bucharest,
    templateKey, subject/paragraphs/cta — the COPY itself is data), `active`.
    Definitions live per site in `config/sites/{sleep,life}.ts` under
    `nurture:` (sleep: 3 sequences, life: 1 — deliberately different, proving
    sites diverge without code). `pnpm db:seed` upserts by key via
    `seedNurtureSequences` — updates name/trigger/steps/consent but NEVER
    `active`: the operator kill switch survives reseeds. Definitions are
    validated loudly (`validateSequenceDefinition`).
  - **Enrollment**: `UNIQUE (sequence_id, subscriber_id)` IS the
    re-enrollment rule — once per sequence, ever; every re-trigger
    (quiz retake, second order, re-confirm) is a no-op, even after
    cancellation. `isMailable` is THE consent gate (GDPR-critical): granted
    `consent_key` consent AND `confirmed_at` — every trigger path runs
    through it and the drain re-checks it per send. Enrollment materializes
    all step sends atomically with `scheduled_at` from
    `computeStepScheduledAt` (pure; Intl-based Europe/Bucharest wall-clock,
    DST-proof — unit-tested across both 2026 transitions; never schedules
    into the past).
  - **Trigger hook points**: newsletter confirm route (also back-fills
    quiz-triggered sequences for results claimed before confirming — the
    quiz → signup → confirm path), quiz rezultat `?/email` action (mailable
    subscribers only), shop webhook post-commit for paid orders
    (best-effort, try/caught — nurture must never fail a processed payment;
    "first order only" falls out of the unique enrollment, no counting).
  - **Drain** (`drain.ts`, behind `/api/cron/nurture-send`, every 15 min in
    `vercel.json`): one transaction claims ≤ `NURTURE_SEND_BATCH=25` due
    sends with `FOR UPDATE SKIP LOCKED` (concurrent invocations get DISJOINT
    batches — proven with real parallel drains) and flips them `sending`;
    per send it re-checks the consent gate (cancels the enrollment when
    consent is gone), renders the step and sends with idempotency key
    `nurture:<enrollmentId>:<stepIndex>` — the email_log unique key is the
    independent second layer (a stale-claim retry after delivery comes back
    `skipped`, recorded as sent). Failures: back to `pending` with backoff
    15m/1h/4h/16h (`retryDelayMs`), parked as `failed` after
    `NURTURE_MAX_ATTEMPTS=5`. Crashed invocations: `sending` rows re-claim
    after `NURTURE_STALE_CLAIM_MINUTES=15`. Max drift = one cron interval
    (+1 per 25 backlogged sends) — day-granular steps make that irrelevant.
  - **Withdrawal stops everything**: unsubscribe route calls
    `cancelSubscriberNurture` (pending sends + active enrollments cancelled
    across sequences, immediately); the per-send gate recheck is defense in
    depth. Every nurture email renders the subscriber's non-expiring
    unsubscribe link (template `nurture` — subject/copy from step data,
    unsubscribe footer NOT optional). GDPR erasure cascades enrollments +
    sends with the subscriber row.
  - Barrels: `index.ts` universal (types + pure schedule/definition — safe
    for site config and plain node), `server.ts` (schema, services, drain,
    `getNurtureDrainDeps()`); `service.ts` stays alias-free and node-safe
    (the seed script imports it directly). NOTE: runtime imports of another
    module's non-schema internals are lint-banned — nurture inlines crm's
    one-line granted check in `isMailable` instead of importing `hasConsent`.
- **Admin** `/admin/nurture` (admin-only; in `ADMIN_ONLY_SECTIONS` + nav):
  per-sequence stats (enrolled, sends pending/sent/failed) and the
  activate/deactivate toggle — deactivation pauses the queue rows in place
  (the claim filters on `sequences.active`), reactivation resumes them; no
  deploy needed to stop a bad sequence. Parked sends listed with email,
  step, attempts, error. Toggle action re-checks `role === 'admin'`.
- **Retention**: `runRetentionSweep` also deletes closed (completed or
  cancelled, via `closed_at`) enrollments after `NURTURE_RETENTION_DAYS=180`;
  sends cascade. email_log stays the durable proof of what was sent.
- **Tests** (+37; unit suite 698 green): `schedule.spec.ts` (DST both ways,
  Bucharest-calendar-day anchoring, past-clamp, backoff table, definition
  validation), `nurture.spec.ts` (consent gate incl. NO-consent ⇒ NO
  enrollment ever, once-per-sequence, quiz band filter + confirm back-fill,
  order normalization, step1-then-step2 time-travelled via injected `now`,
  2-concurrent-drains exactly-once, bound + backlog drains over runs,
  retry→park visible via `listParkedSends`, stale-claim recovery without
  double delivery, deactivate/reactivate, withdrawal cancels everything +
  drain-time recheck, unsubscribe link end-to-end through the REAL route
  module, seed idempotence + kill-switch survival, GDPR cascade, retention
  window), `nurture-send-route.spec.ts` (503/401/no-op contract),
  `nurture-page.spec.ts` (stats + parked surfaced, editor 403 writes
  nothing, admin toggle, bad payload 400), nurture template render in
  `email.spec.ts`, nurture rows in `retention.spec.ts`. e2e `global-setup`
  clears `nurture_sequences` (cascade) before subscribers.
- Docs: DEPLOYMENT §9 (cron row + retention note), §12 "Scheduled jobs"
  (third route + curl); LAUNCH-CHECKLIST: nurture-cron box (incl. "review
  seeded sequences in /admin/nurture before going live").
- Verified: gate green (lint + check + 698 unit), migrate clean on fresh
  (every DB spec re-migrates from zero) AND populated dev DBs, `db:seed` on
  BOTH sites (3 vs 1 sequences).

## Shipping: cost at checkout, courier seam, AWB, tracking (2026-08-07, NEXT-8)

Shipping went from "free by accident" to priced, charged, invoiced and
fulfilled. Migration `0018_calm_wrecker` (`orders.shipping_cents` +
`orders.shipping_name`; new `shipments` table — unique `order_id`, status,
`last_synced_at` index for the cron). New env vars (all OPTIONAL — mock is
the default): `COURIER_PROVIDER`, `SAMEDAY_USERNAME/PASSWORD/PICKUP_POINT`,
`SAMEDAY_BASE_URL/SERVICE_ID/TIMEOUT_MS`; `CRON_SECRET` now also guards
`/api/cron/shipment-sync`. Six new `shop.*` settings keys.

- **Shipping cost is settings DATA** (`modules/shop/shipping.ts`, pure):
  two option slots from `shop.*` settings — `standard` (always offered;
  `shop.shippingStandardName/PriceBani/Eta`) and `express` (offered while
  `shop.shippingExpressName` is non-empty; the existing
  `shop.freeShippingThresholdBani` zeroes the STANDARD price only — express
  stays a paid upgrade, rule pinned by test).
  `shop.shippingStandardPriceBani` is **launch-required with no placeholder**
  (the `invoice.vatRateBp` pattern): launch:check refuses until the operator
  consciously saves a price (0 = deliberate free shipping). The cart offers
  the options as a no-JS radio (`cart-shipping-option` testids, default
  standard); the `?/checkout` action prices the selected id SERVER-side from
  settings + goods total (`invalid-shipping` on an id not currently
  offered) and passes it to Stripe as the session's single
  `shipping_options` entry (`CheckoutSessionInput.shippingOption`;
  fixed_amount, so the charged total is fixed at creation). The chosen
  option snapshots into session metadata key `ship` (`{i,n,p}`).
- **Order carries shipping separately** — webhook: `shippingCents` from
  `session.shipping_cost.amount_total` (authority) falling back to the
  `ship` metadata; `shippingName` from metadata; `amountTotalCents` stays
  the grand total as charged. Mock gateway sessions add the shipping amount
  to `amountTotalCents` like Stripe; `CheckoutSessionView` gained
  `shippingCents`.
- **Invoice: shipping is its own VAT-bearing line** (`invoice/service.ts`):
  `shipping_cents > 0` appends line `Transport — <shippingName>` (qty 1,
  goods VAT rate — transport follows the main supply), so
  `invoice.grossTotalCents === order.amountTotalCents` EXACTLY — the
  regression anchor test in `shipment.spec.ts`; stornos negate stored lines
  and needed no change.
- **`CourierProvider` seam** (`modules/shop/courier.ts`, StripeGateway
  pattern): `createShipment/getLabel/trackShipment/cancelShipment`, statuses
  normalized to `registered|in-transit|delivered|returned|cancelled`.
  `selectCourierProvider(env)` (pure, chat-provider rules): mock default,
  ambient `SAMEDAY_*` alone never activates, `COURIER_PROVIDER=sameday`
  with incomplete credentials is a BOOT error (validated at shop server
  barrel init). Mock (`mock-courier.ts`): sequential `MOCKAWB…`, in-memory
  map, tracking advances ONLY via the `setTrackingStatus` test hook, label =
  minimal valid deterministic PDF embedding the AWB. Real adapter
  (`sameday-courier.ts`): Sameday chosen (largest RO e-commerce courier,
  public token-auth REST API; interface stays provider-agnostic) — token
  caching, bounded timeouts, `normalizeSamedayStatus` keyword mapping
  (unit-tested offline). HONESTY NOTE: the adapter follows the public API
  but has never been exercised against a live account from this codebase —
  that is a documented launch step (DEPLOYMENT §7 "Shipping" step 4,
  LAUNCH-CHECKLIST Ops box). Playwright forces `COURIER_PROVIDER=mock`.
- **AWB from admin** — `createShipmentForOrder` (`shipment-service.ts`):
  ONE transaction holding the order row lock (courier call inside it, bounded
  by the adapter timeout — that lock is what makes a double-click provably
  unable to register two AWBs; unique `shipments.order_id` backstops),
  paid + `unfulfilled|packed` only, walks fulfillment to `shipped` through
  the state machine via the NEW `applyFulfillmentTransitionInTx` (shared
  in-tx core of `transitionFulfillment` — the single-writer grep still holds:
  the column write lives only in fulfillment-service.ts), events
  `awb-generated` + the transitions. Courier failure returns
  `{error:'courier'}` and writes NOTHING. Post-commit: typed
  `shipping-notification` email (AWB, tracking URL, order link), idempotency
  key `shipping-notification:<awb>` — once per shipment ever, retried only
  after a failed send. Admin detail: shipment box (AWB, status, tracking
  link, label download), generate button (admin-only action, editor 403),
  shipping cost row in the items card. Label route
  `/api/shipments/[id]/label`: admin session ONLY (labels are operator
  artifacts — deliberately no customer token variant), bytes fetched from
  the courier on first request and stored write-once under S3 prefix
  `shipping-labels/` (invoice-documents pattern); hooks.server.ts resolves
  the staff session on `/api/shipments/*`.
- **Status sync cron** — `syncShipmentStatuses`: polls in-flight
  (`registered|in-transit`) rows, oldest `last_synced_at` first (nulls
  first), bounded `SHIPMENT_SYNC_BATCH=25` per run; unchanged status only
  bumps `last_synced_at` (no event — idempotent), a change updates the
  shipment, appends `shipment-status`, and moves fulfillment
  (`delivered`/`returned`) only when legal (an order already `returned` by
  the refund rule just keeps its record in sync); per-AWB courier errors are
  counted and skipped, never kill the run. Route
  `/api/cron/shipment-sync` behind `authorizeCron` (401/503 rules), hourly
  in `vercel.json`; machine-cron equivalent = the same curl (DEPLOYMENT §9 —
  it must run through the app, so `CRON_SECRET` is now relevant on
  adapter-node too). Delivered-status customer email: deliberately NOT
  implemented (the optional part of the deliverable) — kept out to hold the
  diff; the seam is the sync's transition block.
- **Refund rule** (in the `charge.refunded` ledger tx,
  `applyRefundShipmentInTx`): no shipment → fulfillment `cancelled`;
  shipment still `registered` → shipment `cancelled` + fulfillment
  `returned` + the AWB is cancelled with the courier AFTER commit
  (best-effort — outcome recorded as `shipment-cancelled` /
  `shipment-cancel-failed` events; a courier API failure never rolls back
  refund bookkeeping); `in-transit`/`delivered` → both `returned`. Either
  way the cron stops polling. `WebhookDeps` gained optional `courier`.
  NOTE the behavior change vs NEXT-5: a refund now ALSO moves fulfillment
  (it used to leave it untouched).
- **Tests** (+43; unit 661 green) — `shipping.spec.ts` (option selection
  incl. threshold/express/no-code-change repricing, metadata round-trip,
  email template), `courier.spec.ts` (selection rules, mock semantics,
  Sameday status mapping offline), `shipment.spec.ts` (order amounts incl.
  metadata fallback, the invoice==Stripe anchor, AWB idempotency + event
  trail + one-email-per-AWB, courier-failure atomicity, cron bound/
  idempotence/no-op/error-skip, all three refund branches),
  `orders-page.spec.ts` (`?/generateAwb`: editor 403 writes nothing, admin
  happy + idempotent re-click, unpaid 400), label-route spec (authz matrix +
  write-once against real MinIO), cron-route spec (503 unset secret / 401 /
  no-op run; mocks `$env/dynamic/private` — it is a SNAPSHOT under vitest).
  The invoice fs-tripwire now also scans modules/shop, api/shipments,
  api/cron. e2e: new shipping flow in `settings.e2e.ts` (it owns
  site_settings): configure prices via the real settings UI → cart shows
  both options at the configured prices → express purchase → order/invoice
  reconcile → admin generates AWB → shipped badge, tracking link, label
  download, one dry-run shipping email. `global-setup` TRUNCATE list gained
  `shipments` (FK to orders — without it the truncate fails).
  Gotcha hit: `text-(--color-ink)/60` fails the serious-contrast a11y gate
  on the life theme — public-page secondary text needs `/70`.
- Docs: DEPLOYMENT §2 (courier env rows), §7 "Shipping (courier & AWB)"
  (adapter choice, human verification steps), §9 (cron table row), §12
  ("Scheduled jobs" incl. the sync curl); LAUNCH-CHECKLIST: courier account
  box, shipping-settings box, env box, sync-cron box, one-real-AWB box.

## Invoices part 2 — PDF, e-Factura XML, delivery, admin (2026-08-07, NEXT-7)

The NEXT-6 record now becomes documents a customer/accountant can hold, from
the SAME snapshot (`modules/invoice/model.ts` — `InvoiceDocumentModel`; a
storno model carries the original's number/date for the reference). One
migration `0017_lazy_bruce_banner` (`email_log.attachments` jsonb — metadata
only, never bytes). New deps: `pdf-lib` + `@pdf-lib/fontkit` (PDF),
`fast-xml-parser` (offline XML validation), `fflate` (export zip); dev
`unpdf` (text-layer assertions). No new REQUIRED env vars; reserved:
`ANAF_EFACTURA_ENABLED` (setting it without an adapter is a boot error).

- **Deterministic PDF** (`pdf.ts`) — pure pdf-lib+fontkit, no native/browser
  deps (Vercel-safe); per-run stamps pinned to the snapshot ⇒ byte-identical
  re-renders (proven). Font: DejaVu Sans, committed at
  `modules/invoice/fonts/` (TTF + LICENSE + generated base64 module via
  `node scripts/embed-font.ts` — no runtime fs; prettier/eslint-ignored).
  739 KB font, but SUBSET at render ⇒ ~12 KB per invoice PDF. Text layer
  proven complete by extraction (`pdf.spec.ts`): identification, per-line
  VAT, totals, `neplătitor` mention, `FACTURĂ STORNO` + original reference,
  comma-below diacritics. Dates print Europe/Bucharest (`invoiceDateIso/Ro`
  in model.ts — 00:30 EET is NOT yesterday).
- **e-Factura XML** (`efactura.ts`) — UBL 2.1, CIUS-RO 1.0.1
  CustomizationID; storno = negative InvoiceTypeCode 380 + BillingReference
  (RO practice, not 381); categories S/Z/O (O = neplătitor: no percent,
  exemption reason from the snapshotted mention, no supplier VAT id).
  `efactura-validate.ts` = offline tripwire (structure, BR-CO arithmetic
  with the documented per-line-rounding tolerance on BR-CO-17, BR-O, exact
  snapshot agreement), property-tested over odd-bani carts; NOT the ANAF
  schematron. Known gap: no `CountrySubentity` county code (flattened
  NEXT-6 addresses) — documented in README + DEPLOYMENT §7. Submission seam
  `EFacturaSubmitter` (`efactura-submitter.ts`): no-op default returns
  `skipped`, invoked once on first XML store; enrollment steps (qualified
  cert, SPV, OAuth) in DEPLOYMENT.md §7 "Fiscal documents"; nothing fakes a
  submission.
- **Write-once storage + signed retrieval** — documents stored lazily on
  first request in the S3 bucket under private `invoices/<id>.<pdf|xml>`
  (never `uploads/`); determinism makes the write-once race-proof (second
  render = identical bytes). `/api/invoices/[id]/[format]`: admin session
  OR `?t=` HMAC token (`access.ts`, TOKEN_SECRET, 15-min TTL, binds
  id+format+exp) — minted ONLY on the success/lookup page (the unguessable
  Stripe session id is the buyer's proof of claim); anonymous/foreign/
  expired/tampered/editor ⇒ 403, unknown ⇒ 404 (full matrix in
  `invoice-doc-route.spec.ts` against real MinIO). hooks.server.ts now
  resolves the staff session on `/api/invoices/*` too (route decides authz;
  the hook only answers who is asking).
- **Email delivery** — `modules/email` gained typed attachments
  (`EmailAttachment`; Resend adapter posts base64; the log records
  {filename, contentType, size}). Confirmation email attaches the invoice
  PDF via the optional `WebhookDeps.invoiceAttachment` seam
  (`invoicePdfAttachmentForOrder`) — attachment-path chosen over link-only
  (PDFs are ~12 KB); ANY document-layer failure is caught and the email
  still goes (customer keeps the durable link; test pins it). New template
  `invoice-email` for the admin re-send. `order-confirmation` data gained
  optional `invoiceNumber`/`orderUrl` — the durable no-account way back is
  `PUBLIC_SITE_URL + /cos/succes?session_id=…` (`orderLookupUrl`).
- **Customer access** — success page shows a "Factura ta" box (PDF + XML
  links, fresh 15-min tokens per load) and the email links back to it.
- **Admin** — order detail: PDF/XML download links per document, re-send
  action (idempotency key = invoice id + hidden page nonce ⇒ double-click
  sends once, fresh page = deliberate resend), wired next to the NEXT-6
  storno/issue action. Orders list: month picker →
  `/admin/orders/export?month=YYYY-MM` = zip of `facturi.csv`
  (semicolon-separated, comma decimals — RO Excel/accounting import) + all
  PDFs/XMLs; admin-only, month filtered on the Bucharest calendar.
- **Serverless constraint enforced** — a grep spec (documents.spec.ts)
  fails if anything under modules/invoice, modules/email, api/invoices,
  api/stripe or admin/orders imports `fs`; `DEPLOY_TARGET=vercel pnpm
  build` verified.
- `util/money.ts` additions: `centsToDecimal` (dot/comma) and
  `centsPerUnitToDecimal` (4-decimal unit net) — amounts still meet strings
  only there.
- Tests — `pdf.spec.ts` (determinism, text-layer completeness, diacritics,
  storno, neplătitor); `efactura.spec.ts` (validity+snapshot agreement,
  property over carts×rates, category O, storno shape, validator bites on
  tampering, submitter seam honesty); `access.spec.ts` (token matrix);
  `documents.spec.ts` (write-once with counting storage double, seam fired
  once, dry-run email carries attachment meta+number+link, broken doc layer
  never blocks email, idempotent resend, fs-grep); route specs for download
  authz (real MinIO) and the monthly export (zip contents, CSV shape,
  guards). e2e: purchase → invoice download (owner token + tamper/anon 403)
  → admin download/resend/export, in `settings.e2e.ts` (it owns
  site_settings; issuer config completed via the real settings UI).
  Verified: gate green (lint/check/`test:unit` 618), full e2e green both
  sites (77 passed / 3 skipped), migrate clean on fresh AND populated DBs,
  `DEPLOY_TARGET=vercel pnpm build` green.

## Invoices part 1 — the fiscal record: numbering, snapshot, VAT, storno (2026-08-07, NEXT-6)

`modules/invoice` owns the DATA of Romanian invoicing; NEXT-7 renders/delivers
the document and must need nothing beyond what is stored here. Migration
`0016_special_ken_ellis` (tables `invoices`, `invoice_lines`, `invoice_series`;
`orders.billing_company` jsonb; append-only triggers). No new env vars. One new
setting key: `invoice.vatUnregisteredMention` (default „Neplătitor de TVA”).

- **Append-only record** — `invoices` + `invoice_lines` store a COMPLETE
  snapshot at issue time: issuer identification copied from settings (a later
  settings edit cannot rewrite history — proven by test), buyer (name, email,
  flattened shipping address, optional B2B company fields), series/number/
  display number (`BSL-0042`), issue = due date (orders are prepaid), per-line
  qty/unit-price/VAT-rate-bp/net/vat/gross and summed totals, `mentions`
  (neplătitor mention + payment-terms note). Immutability is enforced at the
  DB level — `BEFORE UPDATE OR DELETE` triggers on both tables raise (in
  migration 0016; TRUNCATE deliberately stays possible for the test harness)
  — and at the service level (no update/delete API). The `orders` FK has no
  cascade, so an invoiced order cannot be deleted. GDPR erase (`modules/gdpr`)
  now also nulls `orders.billing_company` but leaves invoices intact
  (Legea 82/1991 art. 25 retention, GDPR art. 17(3)(b); the erase summary/CLI
  reports `invoicesRetained`) — decision + basis in `modules/invoice/README.md`.
- **Gapless race-free numbering** — `invoice_series` (series PK, next_number);
  allocation is `UPDATE … SET next_number = next_number + 1 … RETURNING` so
  concurrent issuances serialize on the row lock INSIDE the issuing
  transaction: rollback returns the number (no gap), unique `(series, number)`
  backstops duplicates. The series row is created on first use from
  `invoice.seriesPrefix`/`invoice.nextNumber` settings (so a series can
  continue off-app numbering); afterwards the ROW is the authority — proven by
  a test that edits the setting and issues again. Race test: 8 truly
  concurrent issuances → consecutive numbers, then continuation; green on
  `pg` AND `neon` drivers.
- **VAT in integer bani** — `modules/invoice/vat.ts` (pure): catalog prices
  are gross (what Stripe charged), VAT is EXTRACTED per line —
  `vat = gross·r/(10000+r)` rounded HALF-UP per line, totals = sums of lines
  (per-line is what RO practice/Ordinul 2634/2015 expects; rationale + the
  pinned case where total-rounding disagrees are in the README and
  `vat.spec.ts`). `company.vatRegistered=false` ⇒ 0% lines + the
  `invoice.vatUnregisteredMention` setting snapshotted into `mentions`.
- **Automatic idempotent issuance** — the webhook issues the invoice INSIDE
  the same `runOnce` ledger transaction that creates the order (paid orders
  only), so a redelivery/resend cannot double-issue (partial unique index
  `(order_id) WHERE kind='invoice'` backstops). `charge.refunded` issues the
  storno the same way: a NEW document, own number in the same series,
  `storno_of_invoice_id` → original, lines NEGATE the original's stored
  amounts (never recomputed — exact reversal; one storno per invoice by
  unique index). Issuance failure (issuer settings unset/placeholder —
  `REQUIRED_ISSUER_SETTINGS`) never fails the order: recorded as
  `invoice-failed`/`storno-failed` on `order_events`, naming the missing keys.
- **B2B capture** — optional company fields (name/CUI/Reg. Com.) on the cart
  checkout form (`parseBuyerCompanyForm`: all-empty ⇒ consumer sale, CUI shape
  validated via the new `$lib/util/cui.ts` CUI_PATTERN, name required if any
  field set), carried in session metadata key `company` (compact `{n,c,r}`),
  stored on `orders.billing_company`, snapshotted into the invoice buyer
  fields. Erased on GDPR anonymization; retained on the invoice.
- **Admin surface** — orders list: new filter `invoice-missing` (paid or
  refunded without invoice, or refunded without storno) + amber „fără
  factură” badge; `listOrders` now left-joins the fiscal documents and
  returns `invoiceNumber`/`stornoNumber` per row (`OrderListRow`). Order
  detail: fiscal-documents box (number, kind, date, gross) and the one-click
  `?/issueInvoice` action → `ensureInvoicesForOrder` (locks the order row
  FOR UPDATE — safe against a racing webhook redelivery — issues whatever is
  missing: invoice, plus storno for refunded orders; admin-role re-checked in
  the handler). New order-event kinds rendered: `invoice-issued`,
  `invoice-failed`, `storno-issued`, `storno-failed`.
- **Module boundaries kept honest** — invoice/service writes `order_events`
  via schema (documented: importing the shop service barrel would cycle);
  webhook imports `$lib/modules/invoice/server` + `$lib/modules/settings/server`;
  CUI_PATTERN moved from the settings registry to `$lib/util/cui.ts` because
  e2e helpers import `shop/checkout.ts` outside Vite (no `$lib` there).
- Tests — `vat.spec.ts` (rate table incl. the exact-.5 tie at 3 bani/20%, the
  per-line vs per-total divergence case, integer guards); `invoice.spec.ts`
  (race; snapshot incl. later-settings-edit immunity; neplătitor; webhook
  exactly-one-invoice under redelivery AND dashboard resend; storno negation
  with original bit-for-bit unchanged; DB-level UPDATE/DELETE rejection incl.
  drizzle-level and order-delete FK; failure → `invoice-failed` note →
  work-queue filter → retry-after-fix → idempotent second click; refund
  without invoice → `storno-failed` → retry issues both; erase leaves the
  snapshot readable and reports the retained count); `orders-page.spec.ts`
  (the REAL `?/issueInvoice` action: editor 403 writes nothing, no-settings
  400 with trail entry, success + detail load shows the document);
  `shop.spec.ts` updated: order-creation trail is now `created` +
  `invoice-failed` (that spec runs settings-less on purpose — the failure
  path is exercised by every legacy webhook test). e2e `global-setup` resets
  order+fiscal tables AND `processed_events` via TRUNCATE (row DELETE is
  trigger-blocked on invoices; the ledger row for the fixed per-site webhook
  event id would make a rerun's first delivery a duplicate). `shop.e2e.ts`
  had a STALE pre-NEXT-5 expectation (never rerun since — NEXT-5 had no e2e
  deliverable): same-event-id redelivery now correctly expects
  `duplicate-event`, and a new-event-id resend covers `duplicate-session`.
  Verified: gate green (`lint`/`check`/`test:unit` 582), `test:neon` green
  (582/582), migrate clean on fresh AND populated (2 pre-existing orders) DBs,
  FULL e2e green on both sites (75 passed / 3 skipped).

## Order lifecycle: event ledger, fulfillment states, admin work queue (2026-08-07, NEXT-5)

The two foundations invoicing (NEXT-6/7) and shipping (NEXT-8) sit on:
exactly-once webhook processing for EVERY event type, and a fulfillment
dimension on orders with an audit trail. Migration `0015_furry_eternity`
(new tables `processed_events`, `order_events`; `orders.fulfillment_status`
+ index). No new env vars.

- **`processed_events` ledger** — `lib/server/event-ledger/` (`schema.ts` +
  framework-free `core.ts`). `runOnce(db, {provider, eventId, eventType},
  effect)` claims the (provider, event id) PK by insert INSIDE the same
  transaction the effect writes through: redelivery of ANY handled type skips
  the effect and reports the recorded `outcome` (so admin/debugging can see
  why an event did nothing); concurrent deliveries serialize on the claim; a
  throwing effect rolls back claim + partial writes together, so a poisoned
  event stays retryable. **Retention: 90 days** (`PROCESSED_EVENTS_RETENTION_DAYS`
  in core.ts) — Stripe retries ≤3 days and allows manual dashboard resends for
  30; 90 is comfortably past both while keeping the table a bounded working
  set (the durable history is `order_events`). Wired into the existing
  `runRetentionSweep` (`server/retention.ts`), so both the VPS cron script and
  the Vercel cron route sweep it — no new deploy step.
- **Webhook idempotency is now two-layered** (`modules/shop/webhook.ts`):
  the ledger keys on the provider EVENT id (new outcome `duplicate-event`,
  carrying the first delivery's outcome); the unique `stripe_session_id`
  claim still collapses the same SESSION arriving under a NEW event id
  (`duplicate-session` — Stripe dashboard resends do this). `charge.refunded`
  is idempotent for the first time (before: a redelivery re-ran the handler);
  unknown event types are acknowledged WITHOUT a ledger row (no effect to
  guard; would grow with every category Stripe adds). Order confirmation email
  stays post-commit + idempotency-keyed on the order id.
- **`orders.fulfillment_status`** — separate dimension from payment `status`:
  `unfulfilled → packed → shipped → delivered`, plus `returned` (from
  shipped/delivered) and `cancelled` (only BEFORE shipping); `packed →
  unfulfilled` is a deliberate unpack correction; `returned`/`cancelled` are
  terminal. Pure state machine in `modules/shop/fulfillment.ts` (client-safe —
  the admin UI renders legal moves from it, typed `IllegalTransitionError`);
  THE single writer is `transitionFulfillment` (`fulfillment-service.ts`),
  which locks the row (`FOR UPDATE`), validates, and appends the matching
  `order_events` row in the same transaction — status and history cannot
  drift. A unit spec greps all of src and fails if anything else writes the
  column. Migration backfill: pre-existing `refunded` orders →
  `cancelled` (never going to be fulfilled; must not look like pending work),
  everything else `unfulfilled` via the column default — verified against a DB
  seeded with pre-migration orders.
- **`order_events` audit trail** — append-only per-order history (kind,
  actor = staff email or `stripe-webhook`, from/to status, note). Writers:
  webhook (`created`, `refund-marked`), fulfillment service
  (`fulfillment-transition`). Invoices/AWBs hook into the same trail next.
- **Admin work queue** — `/admin/orders?f=…`: default (and unknown-filter
  fallback) is `action` = paid orders still `unfulfilled`/`packed` — the daily
  to-do, oversold included and badged; `oversold` = flagged orders still
  pre-shipping (the ones where restock/partial-refund/apology is undecided —
  the flag existed since FIX-5 but nothing consumed it); `all`; or any single
  fulfillment status. `/admin/orders/[id]`: fulfillment badge, history
  timeline, and the LEGAL transitions as form-action buttons with a note
  field — action re-checks `role === 'admin'` in the handler (defense in
  depth), 400s an illegal/unknown target without writing.
- Tests — integration (`shop.spec.ts`): duplicate `charge.refunded` marks
  refunded ONCE and the redelivery reports the ledger hit (fails pre-ledger);
  ledger row + effect roll back atomically on a poisoned event, retry then
  succeeds; same session under a new event id still yields one order/decrement
  with both event ids on the ledger. `event-ledger.spec.ts`: first/duplicate/
  cross-provider delivery, rollback, 3-way concurrent race → exactly one
  effect. `retention.spec.ts`: 91-day-old ledger row swept, 31-day-old
  SURVIVES the 30-day counter sweep. `fulfillment.spec.ts`: full legal-
  transition table, everything else rejected, single-writer grep.
  `orders-page.spec.ts` (real route modules against TEST_DATABASE_URL):
  service transition + event atomicity, illegal transition writes nothing,
  work-queue filters incl. oversold entering/leaving the queue, editor 403
  before any write. Verified: gate green, `test:neon` green (553/553),
  migrate clean on fresh AND populated DB.

## RO legal surface + consent-gated analytics (2026-08-07, NEXT-4)

The NEXT-3 settings now RENDER, and analytics exist behind the consent gate
that was left for them. No schema changes; three new OPTIONAL env vars
(`PUBLIC_ANALYTICS_*`, documented in `.env.example` + DEPLOYMENT.md §2).

- **Trader identification renders from settings** — `modules/settings/legal.ts`
  (`legalIdentity()`: pure display model; unset/blank/`PLACEHOLDER — …` values
  become `null`, `displayCui()` RO-prefixes exactly when
  `company.vatRegistered`) + `LegalIdentity.svelte`, rendered by the (public)
  layout footer on EVERY public page and, boxed as `legal-page-identity`, on
  the legal pages by `/pagini/[slug]` (slugs in `LEGAL_PAGE_SLUGS`). ANPC
  SAL/SOL links come from `legal.anpc*Url` settings with
  `target=_blank rel=noopener`. `legal.spec.ts` SSR-renders the component
  (this repo's first `svelte/server` render specs — the pattern works in the
  node vitest project) and scans components/routes/site-configs asserting no
  hardcoded Reg. Com./CUI/anpc.ro/ec.europa.eu literal ever appears.
- **Cookie policy is derived from code** — `modules/gdpr/cookies.ts` is THE
  inventory (auth session, `cart`, `cookie_consent`, `chat_session`,
  `PARAGLIDE_LOCALE`); `CookieTable.svelte` renders the policy table from it.
  `cookies.spec.ts` closes the loop: it greps src for `cookies.set/delete`
  and `document.cookie` writes — a NEW cookie fails the suite until it gets
  an inventory entry (server-only names are literals in the inventory, pinned
  to the real constants by the spec). New seeded page
  `/pagini/politica-de-cookie-uri` (`COOKIE_PAGE_SLUG`, `ensurePage` — the
  lawyer-editable prose must NOT duplicate the table). Linked from the
  consent banner ("Află mai multe" now points here, not at privacy) and both
  sites' `footerLinks`.
- **Analytics seam** — `modules/analytics/`: `selectAnalyticsProvider(env)`
  returns `null` (no-op, the default — nothing ships) or a serializable
  script config for `plausible`/`umami` when the full
  `PUBLIC_ANALYTICS_{PROVIDER,HOST,SITE_ID}` trio is present; half-set or
  unknown throws (chat-provider pattern), and `launch:check` reports it
  (a half-set trio would 500 every public page). `server.ts` is the node-safe
  barrel (no `.svelte`) for scripts/`$lib/server`. Both providers run
  cookieless — `cookieNames` exists for revocation + the inventory spec, so a
  future cookie-setting provider fails tests until the policy knows it.
- **Consent gating end-to-end** — the (public) layout load ships
  `data.analytics`; `AnalyticsLoader.svelte` (mounted ONLY there — admin/api
  are structurally untracked, plus `isTrackablePath()` as defense) injects
  the script in an `$effect` gated on `shouldLoadAnalytics(config, decision,
  path)` and removes it on cleanup. The live decision is
  `localDecision ?? data.cookieConsent`, fed by the banner's new `onchange`
  prop — accepting tracks immediately, no reload. `track()` (`events.ts`)
  sanitizes custom-event props (PII-named keys, email/phone-shaped values
  dropped); nothing sends custom events yet.
- **Revocation** — `ConsentManager.svelte` on the cookie-policy page:
  re-reads `document.cookie` on mount (`consentFromCookieHeader`), buttons
  accept/revoke; revoke rewrites the consent cookie, drops provider-declared
  analytics cookies and `location.reload()`s (removing the tag would leave an
  executed script's listeners alive — reload is the honest stop).
- **e2e** — `analytics-consent.e2e.ts`: playwright config points
  `PUBLIC_ANALYTICS_HOST` at each preview server's OWN origin (nothing leaves
  localhost; other specs just 404 the script URL harmlessly), the spec
  intercepts the script route with a stub that phones a same-origin endpoint:
  refuse ⇒ zero requests, accept ⇒ exactly one tag + one request (and
  persists across reload), revoke on the policy page ⇒ tag gone, counters
  frozen, cookie `denied`; admin never loads it even when granted.
  `settings.e2e.ts` gained the legal-surface test (in that file ON PURPOSE —
  it depends on the company data saved by its first test, and parallel spec
  files would race the shared `site_settings`): footer identity + ANPC hrefs
  + `rel=noopener`, identity block on both legal pages, cookie table lists
  the real cookie names.
- Docs: LAUNCH-CHECKLIST Legal section (identification/ANPC boxes are now
  "fill in `/admin/settings`, renders automatically"; lawyer review of the
  three seeded pages incl. the new cookie policy stays human; analytics
  decision box added), final-smoke boxes for revocation + footer;
  DEPLOYMENT.md §2 env row. Verified: gate green, full e2e green both sites.

## Site settings: the operator-editable data layer (2026-08-07, NEXT-3)

Everything the launch checklist asks a human to "add to the site" — company
identification, ANPC/SOL links, invoice series/VAT rate, shop shipping knobs —
now has a home: `modules/settings`, edited at `/admin/settings` (the last admin
stub is gone; `StubPage.svelte` deleted). One new migration
(`0014_equal_hardball.sql`), no new env vars.

- **Storage** — `site_settings` (key text PK, value jsonb primitive,
  `updated_at`, `updated_by` → users.id on-delete-set-null). One row per
  setting so later phases add keys WITHOUT a migration. No `site_id` (one db
  per site stays binding).
- **`modules/settings/registry.ts` is THE declaration** of every known key:
  kind (`text`/`multiline`/`url`/`email`/`boolean`/`int`/`bani`/`percentBp` —
  drives the form control, the parser and the validator), default,
  `launchRequired`, `clientSafe`, and the seeded placeholder text. Groups:
  `company.*` (legal name, CUI, VAT-registered flag, Reg. Com., address,
  contact email/phone, optional IBAN/bank), `legal.*` (ANPC SAL/SOL URLs,
  extra notices), `invoice.*` (series prefix, next number, issuer place, VAT
  rate in **basis points**, payment-terms note — consumed by NEXT-6), `shop.*`
  (free-shipping threshold in **bani**, shipping note — consumed by NEXT-8).
  Reading an unknown key is a type error (`SettingKey`); an unset key returns
  the declared default. Validators are hand-rolled (no Zod in this repo) and
  return error CODES mapped to `admin_settings_err_*` paraglide messages.
  Money/VAT input converts via `parseLeiToCents` ("21" → 2100 bp, "49,90" →
  4990 bani) — integer math only. Adding a setting = registry entry + ro/en
  label messages + (if visible) a field label in the admin page's
  `fieldLabels` map; the form/action/seed/launch-rule all derive from the
  registry.
- **Read path** — `event.locals.settings` (typed in `app.d.ts`) is a lazy
  request-scoped loader set by the new `handleSettings` hook: any number of
  loads share ONE query per request (memoized promise), nothing outlives the
  request (serverless-correct — a save is visible on the next request).
  Proven by a query-counting fake-db spec. Admin settings page uses
  `loadSettingsForAdmin` instead (same single query, left-joins users for the
  audit line).
- **Client exposure is explicit** — the `(public)` layout exposes
  `data.publicSettings = clientSafeSettings(await locals.settings())`; ONLY
  registry keys marked `clientSafe` reach PageData. A spec serializes the
  layout payload and asserts IBAN/invoice-series values never appear. Nothing
  RENDERS the settings publicly yet — the footer legal block is NEXT-4's
  deliverable and should read `page.data.publicSettings`.
- **`/admin/settings`** — per-group forms (company/legal/invoice/shop)
  generated from the registry, one `?/save` action per group (hidden `group`
  field) so a half-configured site can still save company data. Server-side
  validation, per-field error codes + echoed values on `fail(400, { group,
  errors, values })`, `saved`/audit testids (`settings-field-<key>`,
  `settings-save-<group>`, `settings-error-<key>`, `settings-saved`,
  `settings-audit`). Plain no-JS POST forms (pages-editor pattern). Settings
  was already in `ADMIN_ONLY_SECTIONS` — editor gets 403 (covered in
  admin.e2e.ts).
- **Seed + preflight** — `pnpm db:seed` inserts `PLACEHOLDER — …` rows for the
  10 launch-required text keys (`seedPlaceholderSettings`, onConflictDoNothing
  — operator edits never overwritten). `pnpm launch:check` now also reads the
  target db (`settingsLaunchProblems`): every launch-required key must be
  saved, not a placeholder, and valid; `invoice.vatRateBp` has no placeholder
  on purpose — it stays "not set" until the operator consciously saves the
  rate. `--dev` acknowledges placeholders; `--no-probe` skips the db read
  (CI). Verified: `--dev` OK on the seeded local env; without `--dev` the same
  env fails with 11 site-setting problems (10 placeholders + the VAT rate).
- e2e `settings.e2e.ts`: admin saves company identification, values persist
  after reload; invalid CUI shows the field error and persists nothing.
  `global-setup.ts` now clears `site_settings` between runs.
- Gate + e2e green on both sites; migration applied cleanly on fresh AND
  populated dbs.

## Deploy pipeline: CI migrations, launch preflight, imgproxy host (2026-08-07, NEXT-2)

Everything between the Vercel/Neon branch and an executable deploy: migrations
got a home in CI, the untickable "grep for dev secrets" checklist box became a
script, and the imgproxy hosting question is decided and committed. No schema
changes, no new required env vars (`CRON_SECRET`/`DIRECT_DATABASE_URL` were
already §12 variables — they are now *enforced* on the vercel target instead
of just documented).

- **Single-source env matrix** — `apps/web/src/lib/server/env-matrix.ts` is
  the ONE declaration of required env vars (boot + Vercel extras) and of every
  committed dev-default value (.env.example secrets, compose `better:better`
  credentials, MinIO keys, the dev Stripe webhook secret). `boot.ts` now
  derives `REQUIRED_BOOT_ENV` from it; `launch-check.ts` derives everything
  else. `launch-check.spec.ts` § "env matrix single-sourcing" asserts both
  consumers see any var added to the matrix — do not grow a second list.
- **`pnpm launch:check [--dev] [--no-probe] [--target=node|vercel]`** — deploy
  preflight (rules: `src/lib/server/launch-check.ts`, CLI:
  `scripts/launch-check.ts`). Numbered report, exit 1 on any problem, exit 2
  on usage errors. Checks: missing vars per target, dev defaults, https +
  `SITE_ID`-domain agreement for `PUBLIC_SITE_URL`, `EMAIL_DRYRUN=false` ⇒
  `RESEND_API_KEY`, `CHAT_PROVIDER=anthropic` ⇒ `ANTHROPIC_API_KEY`,
  test-Stripe-key-in-live-env, imgproxy key/salt shape (hex ≥32, key≠salt),
  and a live probe: uploads `launch-check/probe.png` (1×1 PNG) with the app's
  S3 credentials, requires signed imgproxy URL → 200 and unsigned → 403,
  deletes the object after. `--dev` skips only the prod-only rules (dev
  defaults/https/domain/shape); missing vars and conditionals stay enforced.
  Verified: `--dev` passes on the local env, without it the same env fails
  with 8 numbered problems.
- **`.github/workflows/migrate.yml`** — migrations' home: `pnpm db:migrate`
  against the `DIRECT_DATABASE_URL` **repository secret** on push to `main`
  (before Vercel promotes) and on manual dispatch. Fails closed as its first
  step when the secret is unset, `concurrency: migrate-production` serializes
  runs, never seeds, and ends with **`pnpm db:status`**
  (`scripts/migrate-status.ts`, new): prints applied/PENDING per committed
  journal entry (drizzle stores the journal `when` as `created_at` — that is
  the join key), exits non-zero while any are pending, treats a missing
  migrations table (fresh db, error 42P01 on the *cause* of the wrapped
  drizzle error) as "nothing applied". The workflow YAML is under test —
  `src/lib/server/migrate-workflow.spec.ts` parses it (new devDep `yaml`) and
  asserts triggers, secret, fail-closed guard, migrate→status order, no
  seeding, concurrency.
- **imgproxy runs on Fly.io** — decided; config committed under
  `deploy/imgproxy/` (`fly.toml`: upstream v3 image, `otp`/Bucharest,
  always-on shared-cpu-1x/512MB, `/health` check, same hardening as compose;
  README: exact `fly launch`/`fly secrets set`/`fly deploy` lines, read-only
  R2 token, Cloudflare Cache Everything, rotation). Decision + cost (a few
  $/month) + rejected alternatives (Railway, VPS, Vercel Image Optimization)
  recorded in DEPLOYMENT.md §12.
- Docs: DEPLOYMENT.md §2 (preflight), §6 (pointer to `deploy/imgproxy/`), §12
  (imgproxy decision, CI migrations, first-deploy-only deploy order);
  LAUNCH-CHECKLIST.md accounts/DNS/secrets boxes updated and the Ops section
  rewritten target-conditionally (machine cron vs `vercel.json` +
  `CRON_SECRET`).
- Verified at the phase boundary: gate green, `pnpm test:neon` green, both
  `pnpm build` and `DEPLOY_TARGET=vercel pnpm build` green.

## Neon driver proven over a real WebSocket connection (2026-08-07, NEXT-1)

The `DB_DRIVER=neon` branch had shipped without ever opening a connection
(every test ran over `pg`). It is now exercised for real: the full suite runs
over the WebSocket transport against a local Neon-protocol stack, and the three
unknowns recorded below ("Verification" of the 2026-08-06 section) are answered
by passing assertions. No schema changes, no migrations; `DB_DRIVER` unset is
byte-identical to before (the only client.ts change on that path is dead code
behind `NEON_WS_PROXY`).

- **Local Neon-protocol stack**: compose service `neon-proxy` behind
  `--profile neon` (a plain `docker compose up -d` is unchanged — no new
  container, no new required env). It is Neon's own `wsproxy` — the exact
  WebSocket↔TCP proxy the serverless driver speaks against real Neon — built
  from source at a pinned commit in `docker/wsproxy/Dockerfile`, because the
  prebuilt images (`ghcr.io/neondatabase/wsproxy`, `…/neon_local`) are not
  anonymously pullable (verified: `denied` on every tag tried). Target locked
  to `db:5432` via `ALLOW_ADDR_REGEX`; host port `NEON_WS_PROXY_PORT`
  (default 5488).
- **Driver seam** (`db/client.ts`): when `NEON_WS_PROXY` (`host:port`) is set,
  the neon path dials that proxy — `wsProxy` + `useSecureWebSocket=false`
  (local proxy is plain ws://) + `pipelineConnect=false` (pipelining needs
  cleartext password auth; compose Postgres uses SCRAM). Optional
  `NEON_WS_PROXY_TARGET` (default `db:5432`) is the Postgres address as seen
  from the proxy. Unset (i.e. against real Neon, and in every prod deploy)
  none of this executes. `NEON_WS_PROXY` is host-normalized like the other
  service vars (`config/hosts.ts` now also handles its scheme-less
  `host:port` form).
- **`pnpm test:neon`** (root + web): the FULL unit+integration suite with
  `DB_DRIVER=neon` through the proxy. If the proxy is unreachable it fails
  loudly in `tests/vitest-setup.ts` with the fix in the message
  (`docker compose --profile neon up -d --build`) — it never skips, so a neon
  run can't silently degrade into a pg run. Verified both ways: green with the
  proxy up, a clear per-file error with it stopped.
- **The three unknowns, answered in code** (`src/lib/db/driver-parity.spec.ts`
  + compile-time assertions in `client.ts`):
  1. **`SET statement_timeout` on connect is honored** on a neon-driver
     connection: `SHOW statement_timeout` reports the configured value and a
     query exceeding it is cancelled server-side ("statement timeout"),
     identical under both drivers. The un-awaited `SET` in the pool's
     `connect` hook is safe because the pg protocol is strictly ordered per
     connection. (Verified against the real wsproxy + vanilla Postgres; Neon's
     own PgBouncer parameter handling remains a named residual risk — see
     DEPLOYMENT.md §12 "Known limits" for the one-off command against a free
     Neon project.)
  2. **The WebSocket transport survives the whole integration suite**: 434/434
     tests green under `pnpm test:neon`, zero skips — including the
     blog/shop/gdpr `db.transaction()` services, the drizzle migrator (every
     integration spec re-migrates over the neon connection) and the parity
     spec's explicit commit + rollback cases (a throwing transaction leaves no
     rows, byte-identical results across drivers).
  3. **The `Db` cast hides no runtime difference**: compile-time assertions
     next to the cast prove the neon drizzle type still carries every member
     `keyof Db` promises plus `$client.end()`/`transaction` (a drizzle or
     driver bump that drops one stops compiling); the parity spec's runtime
     surface check walks the pg client's prototype chain and asserts every
     member exists on the neon client. Nothing surfaced — the seam needed no
     behavioral change.
- **Pooled-connection reality check**: with the neon default of 1 connection
  per instance, 8 parallel inserts and 2 parallel interactive transactions
  through one client all complete — concurrent work QUEUES on the single
  connection (second checkout waits for the first release), it does not
  deadlock. The wait is bounded by `DB_POOL_CONNECTION_TIMEOUT_MS` (5s
  default), so a pathological pile-up sheds load instead of hanging.
- **pg-only pool internals pinned**: the three `pool.spec.ts` tests that
  assert node-postgres internals (pg.Pool options object, raw-TCP handshake
  timeout) now pass driver `'pg'` explicitly so `pnpm test:neon` doesn't swap
  the driver out from under them; their neon counterparts live in the parity
  spec.
- **Verification**: `pnpm test:neon` 434 passed / 0 skipped (57 files);
  default gate `pnpm lint && pnpm check && pnpm test:unit` green with
  `DB_DRIVER` unset (430 passed + 4 visible skips: the parity spec's neon
  half, which needs the opt-in profile); `docker compose config --services`
  without the profile lists exactly the old three services. New env vars (all
  optional, dev/test only): `NEON_WS_PROXY`, `NEON_WS_PROXY_TARGET`,
  `NEON_WS_PROXY_PORT`. New files: `docker/wsproxy/Dockerfile`,
  `src/lib/db/driver-parity.spec.ts`. Still needing a human + real accounts:
  the free-Neon-project run recorded in DEPLOYMENT.md §12 Known limits, and
  everything in "Next steps" of `docs/NEXT-VERCEL-NEON.md` from imgproxy
  hosting onward.

## Vercel + Neon as a second deployment target (2026-08-06)

On branch `feat/vercel-neon`, not merged. No schema changes, no migrations. The
target is chosen by env vars; with them unset every byte of behaviour is what
§1–§11 of DEPLOYMENT.md already described, which is why the existing suite is
the regression proof.

- **Adapter** (`vite.config.ts`): `adapter-vercel` when `VERCEL=1` (Vercel sets
  it) or `DEPLOY_TARGET=vercel`; `adapter-node` otherwise, unchanged. Vercel
  runtime is pinned to `nodejs22.x` — the Neon driver needs a global
  `WebSocket`, and everything server-side here is Node-only anyway (node:crypto,
  pg), so the edge runtime was never an option. `/api/chat` declares
  `maxDuration = 60` because the assistant streams.
- **DB driver seam** (`db/client.ts`): `DB_DRIVER` picks `pg` (default, today's
  pool, untouched) or `neon` (`@neondatabase/serverless` + `drizzle-orm/neon-serverless`).
  WebSockets, not Neon's HTTP driver: `db.transaction()` is used by
  blog/shop/gdpr services and HTTP cannot hold an interactive transaction. Two
  deliberate differences on the neon path — `statement_timeout` is applied with
  a `SET` on connect (PgBouncer rejects non-allowlisted startup parameters) and
  the pool defaults to 1 connection per function instance. An unknown
  `DB_DRIVER` throws rather than silently falling back to a real pool.
  `type Db` stays anchored to the node-postgres type; the neon branch casts,
  since both are `PgDatabase` over the same schema with `$client.end()`.
- **Retention job** (`server/retention.ts`, new): `runRetentionSweep()` extracted
  from `scripts/chat-prune.ts`, now called by both the script and
  `GET /api/cron/chat-prune` (scheduled in `apps/web/vercel.json`) — Vercel has
  no machine to run scripts on. The route is guarded by `authorizeCron()`
  (`server/cron.ts`): constant-time bearer compare, and **503 when `CRON_SECRET`
  is unset** so an unconfigured deploy cannot fall open on an empty secret.
- **Migrations**: `drizzle.config.ts` prefers `DIRECT_DATABASE_URL` (Neon's
  unpooled endpoint) over `DATABASE_URL`. Migrations run from a checkout or CI,
  never during the Vercel build.
- **Build-machine guard**: `inContainer()` returns false when `VERCEL`/`CI` is
  set, so the service-host normalization below can never fire in a build.
- **imgproxy stays external** (Fly/Railway/VPS). Teaching the media layer a
  second transform provider would touch `imageSources()` — the function every
  page renders through — and that risk was explicitly not worth taking for this
  step. `src/lib/modules/media/*` and every page are untouched.
- **Verification**: 427 tests green (411 existing + 16 new: driver selection,
  cron auth incl. the fall-open case, retention sweep against the real schema);
  `pnpm check` and lint clean; both `pnpm build` and `DEPLOY_TARGET=vercel pnpm build`
  succeed, the latter emitting `nodejs22.x` functions with streaming enabled and
  `maxDuration: 60` on `/api/chat`. Not deployed live — needs the accounts.

## Initial content directory + service-host normalization (2026-08-06)

Two additions after FIX-8: no schema changes, no migrations. One new optional
env var (`CONTENT_DIR`) and one new script (`pnpm content:init`).

- **`content/` is where a site's starting content lives** (`content/README.md`).
  Files are ordinary export bundles, imported by `pnpm db:seed` after the pillars
  (an import needs them) and by `pnpm content:init` on demand: `content/common/`
  for every site, then `content/<SITE_ID>/`, each in filename order (`010-`,
  `020-` prefixes), so a site-local file can update a common slug. Loader is
  `modules/content/init.ts` — it uses `node:fs`, so it is deliberately NOT in the
  module barrel and stays out of the app bundle. Missing directories are skipped;
  a broken bundle is reported per file and skipped rather than aborting the run,
  and `db:seed` exits non-zero if any failed. Idempotent via `importContent`
  (upsert by slug, media matched by storage key). `content/examples/` holds a
  copyable reference bundle and is never imported. Details under CLI scripts.
- **Service hostnames now adapt to where the process runs** instead of being
  pinned in `.env` — rule and rationale in Env & environment quirks. This
  unblocked the integration suite, `db:migrate` and the seed scripts on the HOST
  with the committed `.env`, which previously died with `ENOTFOUND
  host.docker.internal` and needed a manual override per command.
- **Verification**: full unit+integration suite (411 tests) green on the host
  against the committed `.env`; a `dev-run.sh` launch driven through home → blog
  → article → shop → add-to-cart → cart → quiz → chat → admin login in chromium
  with no 4xx/5xx and no JS errors; a bundle dropped into `content/common/`
  confirmed rendering as a live blog article.

## Remediation FIX-8 (audit Frontend #1–#15 — after FIX-7)

Frontend-only phase: no schema changes, no migrations, no new env vars, no
new scripts. Deliberate rendering/behavior changes are listed below.

- **Chat a11y + UX** (`ChatPanel.svelte`, `ChatWidget.svelte`):
  - The message list is now `role="log" aria-live="polite" aria-atomic="false"`
    (+ `aria-busy` while streaming) so streamed replies are announced.
  - The input has an sr-only `<label>` (message `chat_input_label`, unique id
    via `$props.id()` — the widget and /asistent can coexist on one page).
  - Opening the widget moves focus into the input (`focusInput()` instance
    export on ChatPanel); `Escape` (svelte:window) closes it and returns focus
    to the toggle; the panel container is `role="dialog"`.
  - Auto-scroll only pins to the bottom while the reader is already within
    ~48px of it (scroll listener sets a plain `pinned` flag) — scrolling up to
    re-read is no longer hijacked per token.
  - **Mid-stream errors**: a partial assistant bubble is marked
    `data-failed="true"` (red border + `chat_reply_failed` note) with a
    `chat-retry` button that re-asks the last user question; an EMPTY broken
    bubble is dropped. Retry re-POSTs the same text, so the server records the
    user message twice — accurate (it was asked twice), documented in-code.
- **Cookie banner vs chat widget** (frontend #13): `CookieConsent` publishes
  its measured height as `--cookie-banner-h` on `<html>` (ResizeObserver,
  removed on decision/unmount); the chat widget's `bottom` is
  `calc(1rem + var(--cookie-banner-h, 0px))`. Any future fixed-bottom UI
  should reuse the variable instead of racing z-indexes.
- **SEO**:
  - Home page uses `<Seo>` (title `SITE — tagline`, new `home_seo_description`
    message, canonical, OG) instead of a bare `<title>`.
  - Quiz result pages emit `<meta name="robots" content="noindex">` (PII).
  - `sitemap.xml` now also lists `/magazin`, active site-visible products
    (`listVisibleProducts`) and all CMS pages (`listPages`), each with
    `lastmod`.
  - **hreflang**: the public layout emits `<link rel="alternate"
    hreflang="ro|en|x-default">` per page (de-localized pathname re-localized
    per locale via paraglide, absolute via `canonicalUrl`); the root layout's
    display:none locale-anchor hack is GONE. NOTE: `localizeHref` does NOT
    de-localize its input — always feed it `deLocalizeUrl(url).pathname`.
- **Width-descriptor srcsets** (frontend #5): `buildSrcset` now emits
  `320w…2×w` candidates (ladder 320/480/640/768/960/1200/1600 clamped to
  [w/2, 2w] plus w and 2w; exported `srcsetWidths`); a fixed `h` scales
  proportionally per candidate so fill crops keep their aspect. `<Img>` (and
  markdown `pictureHtml`) emit `sizes` — default `${width}px` (matches the old
  1x/2x behavior), and the public cover/gallery/cart call sites pass real
  viewport-dependent `sizes`, so retina stops over-fetching. `buildSrcset` now
  REQUIRES `w` (compile-time) and ignores `dpr`.
- **CLS placeholder** (frontend #14): `imageSources` falls back to a 4:3
  height for dimensionless media (SVG without width/viewBox) instead of
  emitting no height; Tailwind preflight's `img { height: auto }` means the
  real ratio takes over on load.
- **Double-submit guards** (frontend #11): new
  `$lib/components/single-submit.ts` Svelte action (`use:singleSubmit`) —
  disables all submit buttons inside a plain POST form once a submit is
  accepted; `pageshow` re-enables (bfcache back-nav). Applied to newsletter
  signup, quiz-result email, cart setQty/remove/checkout and product add.
  Admin login (a `use:enhance` form) uses an enhance-callback `submitting`
  state instead. Reuse one of these two patterns for any NEW public form.
- **i18n**: footer legal-nav `aria-label` is now the `footer_legal_aria`
  message (was hardcoded RO). New keys (en+ro, parity 283/283):
  `chat_input_label`, `chat_retry`, `chat_reply_failed`, `footer_legal_aria`,
  `home_seo_description`.
- **formatDate** (frontend #10) needed no code change — the Europe/Bucharest
  pin + TZ-stability spec landed in FIX-7 (`$lib/util/date`); verified no
  stray `Intl.DateTimeFormat`/`toLocale*` remain outside it.
- **Tests** (new ones verified to FAIL against the pre-fix code via targeted
  stash runs): unit — width-descriptor + proportional-height srcset and the
  4:3 fallback (`imgproxy.spec.ts`; the old `1x/2x` and `height: undefined`
  assertions asserted the audited bugs and were updated), `sizes` in rendered
  article images (`markdown.spec.ts`), sitemap lists an active product + CMS
  page and skips drafts (`src/routes/sitemap.xml/sitemap.spec.ts`, real route
  handler against TEST_DATABASE_URL with `$lib/db`/`$lib/server/site`
  mocked). e2e — chat behavioral a11y (focused labelled input, role=log
  live region, Escape), mid-stream SSE error → failed bubble → retry
  (route-injected broken stream), quiz-result `noindex`, and NEW
  `e2e/frontend.e2e.ts` (home SEO metas + hreflang links, newsletter submit
  disabled while POST in flight via delayed route, mobile-viewport
  banner/chat-widget non-occlusion). Full gate + e2e green on BOTH sites.

## Remediation FIX-7 (audit Theme G, architecture #1, simplification #1–#10 — after FIX-6)

Quality phase — refactor only. No schema changes, no migrations, no new env
vars, no new scripts. The one deliberate rendering change is the pinned
timezone in `formatDate` (below).

- **Module-boundary policy is now real and enforced** (Theme G). ESLint
  (`eslint.config.js`, `@typescript-eslint/no-restricted-imports` scoped to
  `src/lib/modules/**`) forbids `../<sibling-module>/…` imports EXCEPT:
  - `../<module>/schema.ts` at **runtime** — FK relations/joins in one shared
    db legitimately need sibling table objects;
  - `import type` of anything — erased at runtime, rename-safe via tsc;
  - `*.spec.ts` files — integration specs deliberately wire modules together.
  Everything else must go through `$lib/util`, `$lib/db`, `$lib/server` or a
  module barrel (`$lib/modules/<name>[/server]`). Enforcement was proven with
  a probe fixture (runtime `../crm/service.ts` errors; schema + type-only
  pass). **Plain-node entry points** (`scripts/*`, `db/seed.ts`) still import
  module files relatively — node cannot resolve `$lib` — but they live
  outside `src/lib/modules` and are deliberately not governed by the rule.
  The three runtime violations flushed out were FIXED, not exempted:
  blog/render → `$lib/modules/media/server` (barrel now re-exports
  `imageSources`), quiz/funnel → `$lib/modules/crm/server`,
  extractMediaRefs → `$lib/util/media-refs.ts`. Consequence: `blog/render.ts`
  and `quiz/funnel.ts` are now Vite-only (they import barrels) — do NOT
  import them from plain-node scripts.
- **NEW shared layer `$lib/util`** (universal, framework-free, node-safe):
  `slug.ts` + `money.ts` (moved verbatim from blog/shop — the blog/shop
  barrels no longer re-export them, routes import `$lib/util/{slug,money}`),
  `result.ts` (generic `Result<T,E>` — the 7 per-module envelopes and gdpr's
  EraseResult are now aliases keeping only their error unions), `email.ts`
  (`EMAIL_RE` + `normalizeEmail`, also used by auth/staff), `object.ts`
  (`isRecord`, was triplicated), `date.ts` (below), `media-refs.ts`
  (`MEDIA_REF_PREFIX` + `extractMediaRefs` — the `media:` convention shared
  by blog markdown, shop description scan and the content CLI).
- **NEW shared db helpers `$lib/db`** (node-safe, imported relatively by
  modules): `unique-slug.ts` — generic `slugTaken`/`ensureUniqueSlug(db,
  {table,id,slug}, base, fallback, excludeId)` replacing the triplicated
  per-table copies (blog/shop/quiz) and pages' collect-all variant;
  `pillar-tags.ts` — `resolvePillarRows`/`setPillars`/`pillarSlugsFor` over a
  `PillarJoin` descriptor replacing the duplicated validate+replace+read in
  blog and shop. Quiz keeps its single `pillar_id` column logic. Any NEW
  sluggable/pillar-tagged entity must use these. Covered by
  `db/pillar-tags.spec.ts`.
- **NEW route helpers**: `$lib/server/forms.ts` — `formStr`/`formStrAll`
  (~40 `String(form.get())` reads), `failResult` (not-found→404-else-400 +
  detail echo; replaces 3 `failOf` copies + pages' inline map),
  `parseListFilter(url, statuses)` (admin list ?status/?q parsing + filter
  echo), `createEntityAction` (the identical create→303-to-editor action on
  all 4 admin list pages; hooks for createdBy + products' post-create Stripe
  sync). `$lib/server/site.ts` gained `resolveSitePillars()` (the
  {slug,name} mapping previously ×4). Public routes (newsletter, cos, login,
  quiz result) still read forms inline — they were not part of the repeated
  admin boilerplate.
- **`formatDate(d, style)`** (`$lib/util/date.ts`): styles
  medium/long/medium-time/long-time, always ro-RO, **timezone pinned to
  Europe/Bucharest** — replaces 11 per-page `Intl.DateTimeFormat`
  declarations and closes the SSR/client hydration mismatch near midnight
  (server UTC vs visitors UTC+2/+3). Dates can render one day different from
  a UTC server's old output — that is the fix, not a regression.
- **Shared editor components**: `$lib/components/CoverField.svelte` and
  `PillarChecklist.svelte` replace the duplicated cover card + pillar
  checkbox list in the article and product editors (labels/testids/aspect
  come in as props — message keys are per-editor). The quiz editor's pillar
  control is a single-select `<select name="pillar">` with a none-option — a
  different control, deliberately left alone.
- **Media delete protection is explicit, not an import side effect**
  (simplification #10): `registerMediaReferenceCheck` and its hidden global
  array are GONE. `deleteMedia(deps, id)` takes `MediaDeleteDeps` whose
  REQUIRED `referenceChecks` field carries the list; the app's one wiring is
  `MEDIA_REFERENCE_CHECKS` in `$lib/server/media-library.ts` (articles +
  products). **Any NEW module that stores media ids/keys must add its check
  there** — `media-library.spec.ts` pins the wired names so a silent drop
  fails CI. hooks.server.ts no longer imports blog/shop server barrels for
  side effects (chat's fail-fast import stays — that one is env validation).
- **Dead code removed** (each verified reference-free across
  src/tests/e2e/scripts): `isPurchasable`, `createImgUrl`, media/server.ts's
  raw imgproxy re-export block, the public unguarded `/dev/form` page (+ its
  `dev_form_heading` message key, en+ro), and ~24 never-imported const
  barrel re-exports (ADMIN_ONLY_SECTIONS, LOGIN_RATE_LIMIT,
  DEFAULT_PAGE_SIZE, HISTORY_LIMIT, MAX_MESSAGE_CHARS, CHAT_MAX_TOKENS,
  CHAT_RETENTION_DAYS, ANTHROPIC_*, BUNDLE_EXCLUDED_COLUMNS,
  CONTENT_BUNDLE_VERSION, CONTENT_TYPES, CONSENT_KEYS,
  CONFIRM_TOKEN_TTL_SECONDS, NEWSLETTER_CONFIRM_PURPOSE,
  CONSENT_MAX_AGE_SECONDS, PRESIGN_EXPIRES_SECONDS,
  UPLOAD_TICKET_TTL_SECONDS, CART_MAX_LINES/QTY, CART_METADATA_KEY,
  MOCK_CHECKOUT_URL_BASE, STRIPE_MAX_NETWORK_RETRIES/TIMEOUT_MS_DEFAULT).
  The underlying consts remain where internally used; only the barrel lines
  went. If a later phase needs one publicly, re-export it again deliberately.
- **Tests**: new `db/pillar-tags.spec.ts`, `util/date.spec.ts`,
  `server/media-library.spec.ts`; `util/slug.spec.ts` + `util/money.spec.ts`
  moved with their modules' files; media.spec now injects its fake reference
  check. Full gate green (lint incl. the new boundary rule, check, 389 unit
  tests), e2e green on both sites, both SITE_IDs boot.
- **Runner gotcha discovered this phase**: this host has NO chromium system
  libraries (`libnspr4` etc.) and no root — a bare `pnpm test:e2e` fails all
  tests in ms with `browserType.launch … error while loading shared
  libraries`. Workaround that produced this phase's green run: `apt-get
  download` the ~16 debs with user-writable state dirs (`-o
  Dir::State::Lists=… -o Dir::Cache=…`), `dpkg-deb -x` into a scratch root,
  and run `LD_LIBRARY_PATH=<scratch>/usr/lib/x86_64-linux-gnu:… pnpm
  test:e2e`. If /tmp was wiped, redo it (or `playwright install-deps` where
  root exists). Both sites verified booting from the adapter-node build
  (home 200, /api/health ok) with the same env as DEPLOYMENT.md.

## Remediation FIX-6 (audit resilience #9/#10, security H3/M1/M2/L1–L7 — after FIX-5)

- **Fail-fast boot env validation** (resilience #10): `$lib/server/boot.ts`
  `assertBootEnv()` runs at `hooks.server.ts` module init — a deploy missing
  any of `SITE_ID`, `DATABASE_URL`, `PUBLIC_SITE_URL`, `BETTER_AUTH_SECRET`,
  `TOKEN_SECRET`, `S3_*` (4), `IMGPROXY_URL/KEY/SALT` refuses to start with
  ONE message listing every problem. Conditionals: `RESEND_API_KEY` required
  when `EMAIL_DRYRUN=false`; `STRIPE_WEBHOOK_SECRET` required when a real
  `STRIPE_SECRET_KEY` is set; `TOKEN_SECRET === BETTER_AUTH_SECRET` refused.
  Verified against the adapter-node build (process dies at import with the
  message). Any NEW required env var must be added to `REQUIRED_BOOT_ENV`
  (or as a conditional) in boot.ts + .env.example + DEPLOYMENT.md §2.
- **`/api/health` never 500s on missing env** (resilience #9): the route
  wraps `getDb()`/`getStorage()` construction (`tryConstruct`) and
  `checkHealth` now takes nullable deps — an unconstructable dependency is an
  immediate `'error'` check, answered 503 `{status:'degraded', checks}`.
- **NEW ENV VAR `TOKEN_SECRET`** (L5): dedicated HMAC secret for newsletter
  confirm tokens (`crm getTokenSecret`), chat session cookies
  (`chat getChatSecret`), quiz funnel confirm links (`getQuizFunnelDeps`)
  and the new upload tickets — all via shared `$lib/server/secrets.ts`
  `tokenSecretFrom(env)` which throws if unset OR equal to
  `BETTER_AUTH_SECRET`. **Rotating/introducing it invalidates outstanding
  confirm links and chat cookies** (chat: verify fails → 403 until the widget
  is reset or DELETE /api/chat — documented, accepted). BETTER_AUTH_SECRET
  now signs staff sessions ONLY.
- **imgproxy secret hygiene** (H3): docker-compose `IMGPROXY_KEY/SALT` use
  `${VAR:?}` — NO committed fallback pair anywhere (an empty pair would
  disable signing entirely; the old committed pair is burned in git history —
  never reuse it). `.env.example` ships empty placeholders + `openssl rand
  -hex 32` instructions; local dev `.env` values were rotated this phase.
  Rotation procedure documented in DEPLOYMENT.md §6.
- **SVG uploads stay allowed but defanged** (M1 — option B; dropping svg
  would have broken the seeded product covers): compose/prod imgproxy get
  `IMGPROXY_SANITIZE_SVG=true` (scripts/handlers stripped — integration-
  tested against the live container with a malicious SVG) and `imageSources`
  signs `att:1` into every SVG URL (`ImgOptions.attachment`) so direct
  navigation downloads instead of rendering in the imgproxy origin. Also
  added source caps `IMGPROXY_MAX_SRC_FILE_SIZE=15 MiB` /
  `IMGPROXY_MAX_SRC_RESOLUTION=50` (L7). The imgproxy container must be
  RECREATED (`docker compose up -d imgproxy`) after pulling this phase.
- **Proxy IP trust documented** (M2): DEPLOYMENT.md §3 "Client IPs behind
  the proxy" — `ADDRESS_HEADER`/`XFF_DEPTH` per topology (1 proxy → xff/1;
  Cloudflare → cf-connecting-ip; direct → neither; never a header the edge
  doesn't strip). Commented stubs in .env.example. No code change needed —
  adapter-node reads these at runtime.
- **Bounded request bodies** (L1): `$lib/server/body.ts` `readJsonBounded`
  reads the stream and bails the moment the cap is crossed (content-length
  is treated as a hint only — it's client-forgeable and absent on chunked).
  Chat: 32 KiB → 413; quiz submit: 256 KiB → 413 (was a header-only check).
  Reuse this helper for any new JSON endpoint. adapter-node's default 512 KiB
  `BODY_SIZE_LIMIT` remains the global backstop (form actions rely on it).
- **Log redaction** (L2): `formatServerError` passes the path through
  `redactLogPath` — `/newsletter/confirm/…` and `/unsubscribe/…` log as
  `…/[redacted]`. Any NEW token-in-path route must be added to
  `TOKEN_PATH_PREFIXES` in `$lib/server/log.ts`.
- **Upload confirm bound to presign** (L3): presign now returns a signed
  `ticket` (`media/upload-ticket.ts`, HMAC over key+exp, 1h TTL, secret =
  TOKEN_SECRET) which confirm requires for that exact key (403 `ticket`
  otherwise) — a staff session can no longer register arbitrary bucket
  objects (seed assets, others' pending uploads) as its media rows. Ticket
  check lives in the ROUTE; the framework-free media service API is
  unchanged (scripts/specs/content-import unaffected).
- **Deliberately deferred — L6** (Stripe `processed_events` ledger): both
  handled event types are already idempotent by domain keys (orders' unique
  `stripe_session_id` claim-by-insert; `charge.refunded` is an idempotent
  status flip); a persistent event-id table would add retention burden
  without closing a real hole. Revisit only if a NON-idempotent event
  handler is ever added.
- **Tests** (fail-against-old verified via targeted stash runs where
  non-obvious): `boot.spec.ts` (parameterized missing-var, dryrun/stripe
  conditionals, secret-equality), `secrets.spec.ts` (pure + wiring: getters
  return TOKEN_SECRET; tokens signed by the app do NOT verify under
  BETTER_AUTH_SECRET), `health-route.spec.ts` (503 not 500 — mocks `$lib/db`
  + media server barrel to throw), `body.spec.ts` (endless chunked stream
  abandoned within ~cap bytes; header-only rejection), `chat-route.spec.ts`
  (413 before any dependency is touched), `upload-ticket.spec.ts`,
  log redaction cases, imgproxy `att:1` unit + live sanitize/attachment
  integration test in `media.spec.ts`.
- No schema changes, no new migrations. New env var: `TOKEN_SECRET`
  (REQUIRED everywhere; e2e/preview inherit it from root `.env`). New
  exports: `assertBootEnv`/`bootEnvProblems`/`REQUIRED_BOOT_ENV`
  (`$lib/server/boot`), `tokenSecretFrom` (`$lib/server/secrets`),
  `readJsonBounded` (`$lib/server/body`), `redactLogPath` (log.ts),
  `signUploadTicket`/`verifyUploadTicket`/`UPLOAD_TICKET_TTL_SECONDS`
  (media server barrel), `ImgOptions.attachment` (imgproxy). Gate green;
  both sites boot from the adapter-node build (home 200 + health ok);
  media+chat e2e re-run green on both sites.

## Remediation FIX-5 (audit Theme E + data HIGH-3/LOW-2, resilience #6/#7/#8 — after FIX-4)

- **Migration 0011 — covering indexes** on every previously-unindexed FK/lookup
  column: `quizzes.pillar_id`/`created_by`, `quiz_results.subscriber_id`,
  `orders.email`/`stripe_payment_intent`, `order_items.product_id`,
  `articles.cover_media_id`/`created_by`, `products.cover_media_id`,
  `media.created_by` — plus **unique `lower(email)` indexes** on `subscribers`
  and `users` (case-variant duplicates now fail at the DB even from writers
  that bypass `normalizeEmail`; keep normalizing — the citext route was not
  taken, no extension needed). Verified on fresh AND populated dbs.
- **Media reference integrity** (data HIGH-3): the delete-blocking reference
  checks already covered article cover/body and product cover/gallery; the
  actual dangling path was `products.description_md` `media:` refs — the
  products check now scans it (id and storage-key forms). Any NEW table that
  references media must still register a `MediaReferenceCheck` (see media
  service docs).
- **Quiz submit is idempotent** (resilience #8, migration 0012): nullable
  `quiz_results.client_token` + unique `(quiz_id, client_token)`. The quiz
  page sends a per-mount uuid header `x-quiz-attempt`; the server stores
  `token.sha256(answers)` and resolves duplicates via onConflictDoNothing +
  re-select, so refresh/replay returns the ORIGINAL result row. Same token
  with EDITED answers is deliberately a new attempt (digest differs).
  Token-less writers (curl, other callers of `submitQuiz`) keep non-idempotent
  behavior — nulls never collide.
- **Rate-limit counters are pruned** (resilience #6): new shared
  `pruneStaleRateLimits(db, table, cutoff)` in `$lib/server/rate-limit`.
  `pruneChatSessions` now returns `{ sessions, rateLimitRows }` (callers
  updated) and sweeps `chat_rate_limits`; `pnpm chat:prune` also sweeps the
  generic `rate_limits` and `login_attempts` (same counter shape / growth
  cause, introduced with FIX-1 after the audit). Cron wiring note in
  DEPLOYMENT.md still applies — one daily `chat:prune` covers all retention.
- **Overselling detected + flagged, not auto-refunded** (resilience #7,
  migration 0013): the webhook's stock decrement is an un-floored
  `UPDATE … RETURNING` inside the order transaction; a negative result clamps
  stock back to 0 and sets the new `orders.oversold` flag (red badge in
  /admin/orders list + detail, message key `admin_order_oversold`). Reasoning
  recorded in webhook.ts: auto-refund would put an external Stripe call back
  inside the transaction (undoing FIX-2/FIX-3 discipline) and a human should
  decide between restock/partial refund for a possibly multi-line order; a
  checkout-time reservation system was judged too heavy (expiry sweeps,
  abandoned sessions) for current traffic. `decrementedStock` (pure helper)
  was deleted with its spec — the floor lives in the detect-and-clamp path.
- **Tests** (each demonstrably FAILED pre-fix via targeted `git stash` runs):
  `db/integrity.spec.ts` (index presence for all 12, forced-plan
  `enable_seqscan=off` EXPLAIN for the refund-webhook + quiz-pillar lookups,
  case-variant subscriber/user inserts rejected with 23505); shop spec
  (description_md media refs claimed; oversell flag + floor; last-unit race
  flags only the second order; exact sell-out unflagged); quiz spec (5 RACED
  duplicate submits collapse to one row; edited-answers/token-less paths
  still insert); chat spec (stale `ip:`/`session:` counter rows deleted, live
  ones survive).
- Migrations 0011/0012/0013 applied to sleep/life/test dbs and verified on a
  scratch fresh db. No new env vars or scripts. Both sites boot (home 200,
  /api/health ok). New exports: `pruneStaleRateLimits` (rate-limit barrel),
  `submissionKey` (quiz service); removed export: `decrementedStock` (shop).

## Remediation FIX-4 (audit Theme D / architecture #2, data HIGH-1, MED-2, MED-3 — after FIX-3)

- **Bundle types are schema-derived** (`content/bundle.ts`): the
  `*Content`/`MediaDescriptor` types are now `BundleFields<Row, Excluded>` over
  `typeof table.$inferSelect` — every persisted column travels in the bundle
  unless listed in the exported `BUNDLE_EXCLUDED_COLUMNS` map (ids, pillar ids
  — slugs travel instead, Stripe catalog ids, createdBy, timestamps; the
  rationale for each is a doc comment on the const). Dates serialize to ISO
  strings via a non-distributive `Serialized<T>` conditional. **Adding a column
  now fails to compile** in the `articleToContent`/`quizToContent`/
  `productToContent`/`mediaToDescriptor` mappers (bundle.ts) until it is mapped
  — and the import side spreads the bundle payload into insert/update values,
  so once mapped it round-trips with no further edits (a new timestamp column
  would still need a `new Date(...)` override in import.ts; the compiler flags
  that too).
- **`media.blurhash` round-trips** (was silently dropped — every imported image
  lost its placeholder). `CONTENT_BUNDLE_VERSION` bumped **1 → 2** and
  `parseBundle` requires the field: v1 bundle files are refused with a version
  error — re-export from the source site (bundles are transfer artifacts, not
  archives).
- **Missing-pillar imports are a hard failure** (data MED-2): when a bundle HAS
  pillars but NONE resolve in the target db, `importContent` returns the new
  `'missing-pillars'` error BEFORE writing anything (no rows, no bucket
  objects) and the CLI exits nonzero — previously it created an untagged,
  invisible item with a warning and exit 0. Opt back in with
  `pnpm content import f.json --allow-untagged` /
  `importContent(deps, bundle, { allowUntagged: true })`; the skipped-pillar
  warning now says loudly when the item ends up untagged. Partially-matching
  bundles still import with the resolvable subset tagged (unchanged).
- **MED-3 resolved by documentation** (on `ensureMedia` in import.ts): storage
  keys embed a per-upload uuid fragment (`mediaKeyFor`), so the bytes behind a
  key never change — match-by-key reuse on re-import is sound and never needs
  a byte refresh. Media orphaned when a re-imported item drops a reference is
  an ACCEPTED leak: rows stay in the target's media library (deletable there,
  guarded by reference checks); sweeping on import could delete media the
  target site reuses elsewhere.
- **Tests** (all demonstrably FAILED against the pre-fix code, verified by
  temporarily restoring the lossy mapper / disabling the refusal): parity tests
  in `bundle.spec.ts` compare `getTableColumns()` minus `BUNDLE_EXCLUDED_COLUMNS`
  against the mapper output keys per content type (also compile-verified: a
  temporary `products.sku` column produced TS2741 in bundle.ts); blurhash
  round-trip assertions and the missing-pillars refusal (nothing written,
  `--allow-untagged` path) in `content.spec.ts`. Note for that spec: test DBs
  reset every run but the `better-base-content-a/-b` MinIO buckets persist —
  a test asserting an object is ABSENT must delete it in its own `beforeAll`.
- No schema changes, no new env vars. CLI change: `pnpm content import` gained
  `--allow-untagged`. New exports from `$lib/modules/content`:
  `BUNDLE_EXCLUDED_COLUMNS`, the four row→bundle mappers, `ImportOptions`.

## Remediation FIX-3 (audit Theme C / resilience #2/#3/#4 — after FIX-2)

- **DB pool bounded** (`db/client.ts`): `createDb(url, config?)` now takes a
  `DbPoolConfig` defaulting to `poolConfigFromEnv(process.env)` (the app's
  `getDb()` passes `$env/dynamic/private` explicitly). Defaults: `max` 10,
  `connectionTimeoutMillis` 5s (a checkout that can't get a connection FAILS
  instead of queueing forever), `idleTimeoutMillis` 30s, and a server-side
  `statement_timeout` 30s sent in the startup packet — Postgres itself cancels
  runaway queries. Consequences: every consumer of `createDb` (scripts, e2e,
  specs) now has a 30s statement ceiling — a future long-running migration/
  backfill script must pass its own config or set `DB_STATEMENT_TIMEOUT_MS`.
  New shared helper `src/lib/server/env.ts` `positiveIntEnv(value, fallback)`
  (framework-free) parses all the env knobs below.
- **Every outbound call is time-bounded**; all factories keep a test seam for
  fetch injection, all knobs live in `.env.example` (commented defaults):
  - Resend (`email/resend.ts`): `AbortSignal.timeout` on the fetch,
    `RESEND_TIMEOUT_MS` default 10s. A hang now surfaces through the existing
    sender catch as a retryable `error` email_log row (webhook redelivery is
    the retry signal, per FIX-2).
  - Stripe (`shop/stripe-gateway.ts`): client constructed with `timeout`
    (`STRIPE_TIMEOUT_MS`, default 20s) + `maxNetworkRetries: 2` (stripe-node
    adds idempotency keys to retries). `createStripeGateway(key, options?)`.
  - Anthropic (`chat/anthropic-provider.ts`): `timeout`
    (`ANTHROPIC_TIMEOUT_MS`, default 60s) + `maxRetries: 2`. The SDK arms the
    timer around reaching the API (headers), NOT the stream body — healthy
    long replies are never cut off.
- **Chat SSE aborts upstream on client disconnect**: the route builds its
  response via `chatSseStream(chunks, abort)` (`chat/sse.ts`, exported from
  the server barrel) whose `cancel()` fires an `AbortController`; the signal
  travels `ChatInput.signal` → `ChatStreamOptions.signal` → the Anthropic
  request (mock provider honors it too). On abort: the provider stream stops
  (no tokens billed to a dead request), the assistant message is NOT
  persisted (user message stays — accurate record), and nothing touches the
  cancelled controller (`close()` on it would throw). Any NEW provider must
  respect `ChatStreamOptions.signal`.
- **Tests** (all demonstrably FAILED against the pre-fix code, verified by
  temporarily reverting the fixes): `db/pool.spec.ts` (env parsing; pool
  constructed with limits via `db.$client.options`; a silent TCP server that
  accepts but never handshakes fails within the connection timeout — hung
  before; `pg_sleep` cancelled by statement timeout — note drizzle wraps pg
  errors, assert on the `cause` chain); resend + sender timeout specs in
  `email.spec.ts`; `stripe-gateway.spec.ts` and Anthropic timeout/abort specs
  in `provider.spec.ts` (hanging fetch honoring its abort signal, injected
  via the factories' fetch seams); `sse.spec.ts` (framing, mid-stream error
  frame, cancel aborts + stops); `chat.spec.ts` (integration: cancel mid-
  stream → provider stops early, NO assistant row).
- No schema changes, no new scripts. New env vars (all optional, documented):
  `DB_POOL_MAX`, `DB_POOL_CONNECTION_TIMEOUT_MS`, `DB_POOL_IDLE_TIMEOUT_MS`,
  `DB_STATEMENT_TIMEOUT_MS`, `RESEND_TIMEOUT_MS`, `STRIPE_TIMEOUT_MS`,
  `ANTHROPIC_TIMEOUT_MS`.

## Remediation FIX-2 (audit Theme B / resilience #1 — after FIX-1)

- **Order creation is all-or-nothing** (`modules/shop/webhook.ts`): the order
  insert (the `stripeSessionId` idempotency claim), the order_items snapshot
  and the stock decrement now run in ONE `db.transaction()`. A mid-flight
  failure rolls back the claim too, so a Stripe redelivery retries the whole
  unit — the old "customer charged, order has zero items, unrecoverable"
  state can no longer exist.
- **Confirmation email is post-commit**: a mail failure can never roll back a
  paid order. The duplicate-delivery path now RE-ATTEMPTS the idempotent send
  (`order-confirmation:<orderId>`) — the email module skips it unless the
  previous attempt errored or never happened, so a redelivery is exactly the
  retry signal for a failed send. An email sender that throws makes the
  webhook 500 (order already committed) → Stripe redelivers → duplicate path
  retries the email; a transport-level error (sender returns status `error`)
  still yields 200 `order-created` and is retried only on a later redelivery.
- **Pillar retagging is atomic** (`blog/service.ts updateArticle`,
  `shop/service.ts updateProduct`): the join-table delete + re-insert + row
  update commit together — a failure can no longer strip an article/product
  of all tags (which silently hid it from every site).
- **GDPR erasure is all-or-nothing** (`gdpr/erase.ts`): quiz unlink +
  subscriber delete + order/email-log anonymization in one transaction; a
  mid-way failure leaves everything untouched and the CLI exits nonzero.
- **Deliberately NOT transactional** (audited, documented in code comments):
  - `quiz/funnel.ts claimQuizResult` — interleaves external email sends;
    every step is individually idempotent, a retry of the whole action heals.
  - `media/service.ts confirmUpload`/`deleteMedia` — storage is external and
    can't join a DB tx; failure modes are an orphan bucket object (harmless)
    or a 404-ing thumbnail healed by retrying the delete.
  - `chat/service.ts` — assistant reply persisted only after the external
    stream finishes; a mid-stream failure records a user message with no
    reply, which is accurate, not corrupt.
  - `crm/service.ts upsertSubscriber` consent merge is a read-modify-write
    (concurrent upserts with DIFFERENT grants could last-write-win); reviewed
    and left — the funnel/newsletter actions are single-user flows and a
    retry re-applies the grant. Revisit only if consents ever get bulk
    writers.
- **Tests**: `tests/helpers/db-fault.ts` — a Proxy wrapper around a Drizzle
  client that makes `insert`/`update`/`delete` on ONE chosen table throw
  while armed, transparently across `db.transaction()`. Used by 7 new
  regression tests (all FAILED pre-fix): webhook items-insert / stock-update
  faults commit NOTHING and the same event redelivers into exactly one
  complete order; concurrent duplicate deliveries; email transport error /
  throwing sender never roll back or duplicate an order and a redelivery
  retries the send (`shop.spec.ts`); article + product retag faults keep the
  old tags (`blog.spec.ts`, `shop.spec.ts`); erase fault leaves the
  subscriber untouched (`erase.spec.ts`).
- No schema changes, no new env vars, no new scripts.

## Remediation FIX-1 (audit Themes A & F — after Phase 7)

- **Shared rate-limit core** at `src/lib/server/rate-limit/` (framework-free;
  import the files relatively from modules/scripts like other shared code):
  `consumeRateLimit(db, table, key, { max, windowMs }, now?)` runs ONE atomic
  `INSERT … ON CONFLICT DO UPDATE … RETURNING` — window rollover is decided in
  SQL and the cap decision comes from the post-increment RETURNING values,
  never a separate read. Counters are **sliding-window** (aligned fixed
  windows; the previous window's count decays linearly across the next one),
  which closes the fixed-window boundary burst. Consequences to remember:
  refused requests still consume slots, and a maxed-out key regains full
  budget only after TWO aligned windows, not one. Works against any table
  with columns (key unique/PK, count, prev_count, window_started_at).
- **Migration 0010**: generic `rate_limits` table (for throttles without
  their own table) + `prev_count` column on `login_attempts` and
  `chat_rate_limits`. Applied to sleep/life/test dbs.
- **Login limiter** (`modules/auth/rate-limit.ts`): `registerLoginAttempt(db,
  key)` atomically counts the attempt BEFORE the password check; success
  still `clearAttempts`. 5 attempts per sliding 15 min per IP+email. The old
  pure helpers (getAttemptState/recordFailure/saveAttemptState/isRateLimited)
  are deleted.
- **Chat limiter**: `chat/rate-limit.ts` is now only `CHAT_RATE_LIMIT`
  (`{ max: 20, windowMs: 1h }` — shared `RateLimitConfig` shape, the old
  `maxMessages` field is gone) + key helpers; `service.ts` consumes the
  session and IP counters atomically via the core.
- **Public email throttling** (audit H2): the newsletter action and the quiz
  result `?/email` action call `consumePublicEmailBudget(db, scope, ip)`
  BEFORE any other work and fail 429 (form errors `rate_limited` /
  `rate-limited`, ro copy `newsletter_rate_limited` /
  `quiz_email_rate_limited`). Caps per scope (`newsletter`, `quiz-email`):
  **10/hour per IP, 200/hour global**, keys in `rate_limits`. A CAPTCHA/
  proof-of-work check would slot in right before that call — documented hook
  point in `public-email.ts`, deliberately not wired. Trade-off: a spent
  global budget refuses ALL signups for up to an hour (deliberate — worse is
  mailbombing victims and burning Resend reputation). Any NEW public endpoint
  that emails a visitor-supplied address must reuse this helper with a new
  scope.
- **Tests**: `server/rate-limit/core.spec.ts` (pure decision math) and
  `rate-limit.spec.ts` (integration: 30 parallel consumes return counts
  exactly 1..30); racing regressions in `auth.spec.ts` (20 parallel login
  attempts, exactly 5 admitted) and `chat.spec.ts` (25 parallel messages,
  exactly 20 streams) — both demonstrably FAILED against the pre-fix
  read-modify-write code; `routes/(public)/public-email-throttle.spec.ts`
  invokes the REAL route actions. **Vitest gotcha discovered there:** `$env`
  values are a build-time snapshot — overriding `process.env` in a spec does
  NOT redirect `getDb()`; mock `$lib/db` (vi.mock + vi.hoisted holder) to
  point route code at TEST_DATABASE_URL.
- e2e `global-setup.ts` now also clears `rate_limits` each run (counters
  outlive a run; the funnel/quiz specs send real signups).

## What exists

- **pnpm workspace**: `apps/web` (SvelteKit 2, Svelte 5 runes, TS strict, Tailwind v4,
  Paraglide with base locale `ro` + `en`, adapter-node) and `packages/formcomp`
  (vendored quiz form library, consumed as `formcomp` workspace dep; its `dist/` is
  built by the root `prepare` script on `pnpm install`).
- **Site config system** (`apps/web/src/lib/config/`):
  - `pillars.ts` — the 9 canonical pillars (ro slugs: `somn`, `nutritie`, `miscare`,
    `stres`, `relatii`, `scop`, `mediu`, `minte`, `finante`).
  - `sites/sleep.ts` (1 pillar) and `sites/life.ts` (9 pillars) — the ONLY places a
    brand string may appear. Shape: `{ id, name, domain, locales, pillars, theme, nav,
chatPersonaKey, email }`.
  - `index.ts` — pure `resolveSiteConfig(siteId)` (throws on missing/unknown id or
    non-canonical pillar). Server code gets the active config via
    `getSite()` from `$lib/server/site` (reads `SITE_ID` from `$env/dynamic/private`,
    memoized per process).
- **Compose stack** (root `docker-compose.yml`): `db` (Postgres 16, host port
  `${DB_PORT:-5433}`; 5432 was taken on this host), `minio` (S3 API on
  `${MINIO_PORT:-9000}`, console on `${MINIO_CONSOLE_PORT:-9001}`) and `imgproxy`
  (host port `${IMGPROXY_PORT:-8888}`, signature required, reads sources from
  `s3://…` via `http://minio:9000` inside the compose network). All dev
  credentials/keys have compose defaults matching `.env.example`.
- **Database**: Postgres 16 (service `db` above). A fresh volume auto-creates
  `better_sleep`, `better_life`, `better_test` (see `docker/postgres-init/`).
  Drizzle: schema barrel `apps/web/src/lib/db/schema/index.ts` (composes future module
  schemas; core has `pillars`), client factory in `db/client.ts`, lazy app client
  `getDb()` in `db/index.ts`. Migrations committed under `apps/web/drizzle/`.
- **Seed**: `pnpm db:seed` upserts the active site's pillars (idempotent);
  logic in `src/lib/db/seed.ts`, entry `scripts/seed.ts` (plain `node`, Node 24 type
  stripping — keep script imports relative with explicit `.ts` extensions).
  Its final step imports the initial-content bundles from `content/` — see the
  `pnpm content:init` entry under CLI scripts.
- **Modules**: `src/lib/modules/{blog,quiz,shop,chat,email,media,auth}/` with barrel
  `index.ts` each. ESLint `no-restricted-imports` forbids importing
  `$lib/modules/<name>/<anything deeper>` — cross-module imports go through the barrel,
  within a module use relative imports.
- **Public skeleton**: config-driven root layout (site name, nav, theme tokens emitted
  as CSS vars `--color-*` on a wrapper div), homepage listing active pillars
  (`data-testid="pillar-item"`), `/sanatate/[pillar]` landing (404 for inactive/unknown
  pillars), `+error.svelte`, `/dev/form` proving formcomp integration.

## Auth & admin (Phase 1)

- **modules/auth** (`apps/web/src/lib/modules/auth/`): better-auth 1.6 with the
  Drizzle adapter (`usePlural: true` — tables `users`, `sessions`, `accounts`,
  `verifications`). Email+password only, **public signup disabled**, password min
  length 12. `users.role` is a better-auth additionalField: `'admin' | 'editor'`
  (default `editor`, `input: false` so it can never come from a request).
  - `auth.ts` — framework-free `createAuth({ db, secret, baseURL, plugins })`
    factory (no `$env`/`$app` imports) used by the CLI, tests and e2e setup.
  - `server.ts` — lazy `getAuth()` for the app: reads `BETTER_AUTH_SECRET` +
    `PUBLIC_SITE_URL`, wires the `sveltekitCookies` plugin so `auth.api` calls in
    form actions set cookies. Session cookie: httpOnly, SameSite=lax; Secure is
    derived by better-auth from an https `PUBLIC_SITE_URL` (so secure in prod).
  - `guards.ts` — pure `guardAdminPath(pathname, role)` →
    allow / login-redirect / forbidden. `ADMIN_ONLY_SECTIONS = products, orders,
subscribers, settings` (editors are blocked there; everything else under
    /admin needs any staff session).
  - `rate-limit.ts` — login rate limit, 5 failed attempts / 15 min per IP+email,
    fixed window persisted in `login_attempts` (pure logic + Db helpers).
  - `staff.ts` — `upsertStaffUser(auth, { email, password, role })`: idempotent
    on email (creates user + credential account, or updates role/password via
    better-auth's internal adapter, hashing included).
- **Creating users**: `pnpm user:create -- --email a@b.ro --password 'min12chars…'
--role admin|editor [--name X]` (root script → `apps/web/scripts/user-create.ts`,
  plain node against `DATABASE_URL`; needs `BETTER_AUTH_SECRET`). Idempotent:
  rerunning with the same email updates role+password.
- **Auth flow**: `/admin/login` form action calls `auth.api.signInEmail` (rate
  limit checked first; failures recorded; success clears the counter) →
  redirect to `/admin`. Logout is a POST action at `/admin/logout` →
  `auth.api.signOut` → back to login. There is NO `/api/auth/*` catch-all —
  all auth goes through form actions.
- **Guarding**: `hooks.server.ts` (`handleAdminGuard`, after paraglide in the
  sequence) resolves the session ONLY for `/admin*` paths, fills
  `event.locals.user` (`{ id, email, name, role }` — typed in `app.d.ts`), then
  enforces `guardAdminPath`: anonymous → 303 `/admin/login`; editor on an
  admin-only section → 403. Role checks are server-side; the sidebar also
  filters entries per role (cosmetic).
- **Routes layout**: public pages moved into `src/routes/(public)/` (URLs
  unchanged; note route ids now include the group — e.g.
  `resolve('/(public)/sanatate/[pillar]', …)`). Root `+layout.svelte` keeps only
  theme/css; the public header lives in `(public)/+layout.svelte`. Admin shell:
  `admin/(shell)/+layout.svelte` (sidebar `data-testid="admin-sidebar"`, header
  with site name + user + logout) with dashboard (placeholder stat cards) and
  stub pages: media→phase 2, articles→3, quizzes/subscribers→4,
  products/orders→5, settings→7. `admin/login` sits outside the shell group.

## Media (Phase 2)

- **modules/media** (`apps/web/src/lib/modules/media/`), with TWO barrels — this
  phase introduced the pattern (ESLint now allows both):
  - `$lib/modules/media` (universal): the `<Img>` component, upload validation
    (`ALLOWED_IMAGE_MIMES` jpeg/png/webp/avif/gif/svg, `MAX_UPLOAD_BYTES` 15 MB,
    `validateUpload`, `mediaKeyFor`) and types only.
  - `$lib/modules/media/server` (server-only): everything that signs or touches
    storage/db — importing it from client code fails the build by design, because
    `IMGPROXY_KEY`/`IMGPROXY_SALT` and S3 credentials must never reach the browser.
- **Schema**: `media` table (migration `0002`) — text id (uuid), `kind`
  `image | video-embed`, `key` (unique storage path, null for video), filename,
  mime, size, width, height, `alt` (not null, default ''), `blurhash` (nullable,
  NOT populated yet — computing it needs pixel decoding, deferred), video
  provider (`youtube | bunny`) + external id, created_by → users, created_at.
  A check constraint enforces the image/video column shape.
- **URL building** (`imgproxy.ts`, pure): `signImgproxyPath` (HMAC-SHA256 over
  salt+path, base64url), `buildImgUrl(cfg, key, {w,h,fit,format,dpr})`,
  `buildSrcset` (1x/2x), `imageSources(cfg, row|key, {w,h,fit})` → serializable
  `ImageSources`. Server-bound shortcuts in the server barrel: `imgUrl()`,
  `imgSources()`. SVGs are emitted unresized/unconverted. The unit test vector
  was validated against the live imgproxy container.
- **Upload flow**: browser → `POST /admin/media/upload` `{op:'presign',
filename, mime, size}` (validates, returns `{key, uploadUrl}`) → browser PUTs
  the file straight to storage (presigned URL signs content-type AND
  content-length — a mismatching PUT gets 403 from storage; see
  `signableHeaders` in `storage.ts`) → `{op:'confirm', key, filename}` verifies
  the object exists, re-validates its real size/mime, reads width/height
  server-side (`image-size`) and inserts the row.
- **`<Img>`** (`Img.svelte`): takes a server-built `ImageSources` (`image` prop),
  renders `<picture>` with avif+webp 1x/2x srcsets and lazy `<img>`; alt comes
  from the row or the `alt` prop; empty alt without `decorative` logs a dev
  warning. URLs are signed ONLY in `load`/endpoints — components never see keys.
- **Admin library** (`/admin/media`, editor-accessible): drag&drop/click upload
  (multiple files), thumbnail grid via imgproxy, inline alt editing
  (`?/updateAlt`), delete (`?/delete` — removes object + row). Deletion is
  refused with 409 while any registered reference check claims the row:
  `registerMediaReferenceCheck({name, isReferenced})` from the server barrel —
  content modules of later phases MUST register one per media-referencing table.
- **Video embeds**: schema + `createVideoEmbed()` service exist and the library
  grid renders such rows as a provider/id card; there is no admin UI to add
  them yet (do it in the phase that first embeds video into content).
- **Storage** (`storage.ts`): `createStorage(cfg)` wraps the AWS SDK v3 client
  (`forcePathStyle: true`). NO MinIO-specific code paths anywhere — switching to
  Cloudflare R2 is purely `S3_*` env var changes (verified by reading the code:
  endpoint/creds/bucket/region all come from config; `ensureBucket` is only used
  by bootstrap/tests, R2 buckets can pre-exist).
- **Bootstrap**: `docker compose up -d` then `pnpm storage:init` (idempotent
  bucket creation; the e2e global-setup also ensures the bucket, and the fresh
  stack path — volume wiped, `up -d`, `storage:init`, full integration run —
  was exercised in this phase).

## Blog (Phase 3)

- **modules/blog** (`apps/web/src/lib/modules/blog/`), split barrels like media:
  - `$lib/modules/blog` (universal): `slugify`/`nextUniqueSlug` (ro-diacritics
    transliteration incl. legacy cedilla ş/ţ; suffix `-2`, `-3`, … on collision),
    `extractMediaRefs`, `ArticleRow` types.
  - `$lib/modules/blog/server`: services + rendering; importing it ALSO registers
    the articles media-reference check (module init side effect). It is imported
    for that side effect in `hooks.server.ts`, so the check is live before any
    request can hit the media library's delete action.
- **Schema** (migration `0003`): `articles` — text id (uuid), unique `slug`,
  title, excerpt, `body_md`, `cover_media_id` FK→media (set null), status
  `draft|published`, `published_at`, `seo_title`, `seo_description`,
  created_by→users, timestamps; `article_pillars` (article_id, pillar_id, PK on
  both, cascade). No site column anywhere — visibility is pillar tagging.
- **Services** (`service.ts`, framework-free `{ db }` deps, `BlogResult<T>`):
  `createArticle` (auto unique slug from title), `updateArticle` (patch incl.
  slug normalize+dedupe — an explicitly taken slug gets suffixed, re-saving your
  own doesn't; `pillarSlugs` replaces join rows, unknown slug → error),
  `publishArticle` (stamps `publishedAt` ONCE — republishing keeps the original
  date), `unpublishArticle`, `getArticle`, `getBySlug` (drafts only with
  `includeDrafts`), `listPublished({pillarSlugs, page, pageSize=9})` (published
  AND tagged to ≥1 given slug; empty list → nothing), `listArticles`
  (admin: status filter + ilike search), `listPublishedForSitemap`.
- **Markdown pipeline** (`markdown.ts` pure + `render.ts` db glue): marked with a
  custom image renderer + sanitize-html allowlist over the OUTPUT (scripts,
  event handlers, `javascript:` URLs, iframes to unknown hosts always stripped;
  src-less iframe shells dropped). `![alt](media:<id-or-key>)` resolves via
  `renderArticleHtml(deps, imgproxyCfg, bodyMd)` to `<picture>` markup
  (avif/webp 1x/2x through imgproxy, w=768) or, for `video-embed` rows, an
  iframe (youtube-nocookie / iframe.mediadelivery.net; external id validated
  against `[A-Za-z0-9_/-]`). Unresolved refs render as nothing.
- **Admin** `/admin/articles` (editor-accessible): create-by-title form → editor
  at `/admin/articles/[id]`; list has status filter + search. Editor: title
  (auto-suggests slug until slug manually edited — server dedupes on save),
  slug, excerpt, markdown textarea with server-rendered preview toggle
  (`?/preview` action), cover picker + inline-image inserter from the media
  library (`MediaPicker.svelte`), pillar checkboxes (site's active pillars
  only), SEO fields, save/publish/unpublish (publish/unpublish also persist the
  form first).
- **Public**: `/blog` (paginated cards, `?page=`), `/blog/[slug]` (drafts 404),
  pillar landing pages list that pillar's latest 6. Site nav configs gained a
  `Blog` entry.
- **SEO**: shared `src/lib/components/Seo.svelte` (title, description, canonical,
  OG, twitter card, optional JSON-LD — assembled with escaped `<` via
  `jsonLdString`) + `src/lib/seo.ts` `canonicalUrl(path)` from `PUBLIC_SITE_URL`.
  Article pages emit JSON-LD `Article` and a fixed-size 1200×630 jpg OG image
  through imgproxy. `sitemap.xml` (static pages + active pillar pages +
  site-visible published articles) and `robots.txt` (disallow /admin, sitemap
  URL) are dynamic routes — the old `static/robots.txt` was REMOVED, don't
  re-add it (it would shadow the route in the build output).
- **Seed**: `pnpm db:seed` also upserts 3 published ro demo articles tagged
  `somn` (fixed ids, upsert-by-slug, idempotent).
- **Typography**: `@tailwindcss/typography` is installed (`@plugin` in
  `routes/layout.css`); rendered article HTML gets `prose` classes.

## Quizzes, subscribers & email (Phase 4)

- **modules/email** (split barrels): idempotent transactional email.
  - `email_log` table (migration `0004`): every attempt is recorded — real
    sends AND dry-runs. The unique `idempotency_key` is claimed BY INSERT, so
    concurrent retries collapse to one row; statuses `sending|sent|dryrun|error`
    (only `error` rows may be retried, guarded re-claim).
  - `createEmailSender({ db, dryRun, from, replyTo?, transport? })` →
    `.send({ to, template, data, idempotencyKey })`. **`EMAIL_DRYRUN` defaults
    to TRUE** (only `EMAIL_DRYRUN=false` + `RESEND_API_KEY` sends for real, via
    the fetch-based Resend adapter in `resend.ts`). `getEmailSender()` (server
    barrel) is the env-bound singleton; `from` comes from site config.
  - Templates are typed functions (`templates.ts`, universal barrel):
    `quiz-result`, `newsletter-confirm` → subject+html+text, ro copy, all
    interpolations escaped. Add new templates to `TemplateData` +
    `EMAIL_TEMPLATE_KEYS` + the render switch.
- **modules/crm** (NEW module — subscribers live here, not in quiz, because
  newsletter signup exists independently; the phase plan left this open):
  - `subscribers` (migration `0005`): unique email, `consents` jsonb
    (`newsletter` / `profile_emails`, each `{ granted, at, source }`),
    `confirmed_at` (double opt-in stamp), non-expiring `unsubscribe_token`.
    Newsletter-mailable = granted consent AND confirmed_at.
  - Consent semantics (`consent.ts`, pure, unit-tested): callers pass only
    EXPLICIT intents — an unticked checkbox never revokes; re-affirming an
    unchanged value keeps the ORIGINAL record (proof of first consent, and it
    keeps retry idempotency keys stable). Revocation via `/unsubscribe/[token]`
    (revokes ALL consents, source `unsubscribe`) or an explicit `false`.
  - Signed action tokens (`token.ts`): HMAC-SHA256, base64url payload+sig,
    purpose + expiry checked (`timingSafeEqual`). Secret = `BETTER_AUTH_SECRET`
    via `getTokenSecret()`. Confirm tokens live 7 days
    (`CONFIRM_TOKEN_TTL_SECONDS`); known limitation: an unconfirmed subscriber
    re-signing up gets NO fresh confirm email (same consent timestamp → same
    idempotency key) — the old link must still be valid.
  - Services: `upsertSubscriber` (normalizes email, merges consents, race-safe
    insert), `requestNewsletterSignup` / `sendNewsletterConfirmEmail`,
    `confirmSubscriber` (stamps once), `unsubscribeByToken`, `listSubscribers`,
    `subscribersCsv` (pure, quoted).
  - `NewsletterSignup.svelte` (universal barrel): plain POST to `/newsletter`,
    consent checkbox default-unticked + required; used in the public footer
    (`(public)/+layout.svelte`) and on `/blog`.
- **modules/quiz**:
  - Schema (migration `0006`): `quizzes` (unique slug, title, `intro_md`,
    `pillar_id` FK, `form_schema` jsonb = formcomp FormConfig, `scoring` jsonb,
    status, `result_template_key`) and `quiz_results` (quiz FK cascade,
    NULLABLE subscriber FK set-null, `answers` jsonb = sanitized formcomp
    submit answers keyed by stable uuid, integer `score`, `profile` jsonb).
  - Scoring engine (`scoring.ts`, pure, TDD): question specs `{kind:'map'}`
    (value→points; multi-select sums selections) or `{kind:'numeric'}`
    (clamped to question min/max × multiplier, then `cap`); dimension sums with
    ro labels; bands by ascending inclusive `min` (score exactly on a threshold
    → higher band; below all → first). Missing/unknown answers score 0.
    `maxScore` computed (null when a numeric question is unbounded).
    `validateScoringConfig(form, raw)` → ro errors for the admin editor.
  - **IMPORTANT**: never runtime-import `formcomp` from server/node code — its
    only export pulls .svelte files, which plain node (seed script, drizzle
    scripts) cannot load. `import type` is fine; structural checks live in
    `validate.ts` (`validateFormSchema`, `validateForPublish`); formcomp's own
    `validateConfig` runs client-side only (admin editor).
  - Services: CRUD with unique ro slugs (reuses blog slug helpers), publish
    gate (≥1 question + valid scoring), `getQuizBySlug` (drafts hidden by
    default), `listQuizzes` (+result counts), `sanitizeSubmittedAnswers`
    (drops unknown question ids, coerces strings), `submitQuiz` (scores +
    stores), `latestResults(WithEmail)`.
  - Funnel (`funnel.ts`): `claimQuizResult` upserts the subscriber (ticked
    boxes only, source `quiz:<slug>`), links the result row, sends the
    TRANSACTIONAL quiz-result email with key
    `quiz-result:<resultId>:<email>` (retries skip; a corrected typo still
    gets its email) and starts double opt-in when newsletter was ticked.
    `getQuizFunnelDeps()` wires db/sender/secret/`PUBLIC_SITE_URL`/site name.
- **Public routes** (`(public)/`): `/quiz/[slug]` renders MultiStepForm from
  the stored schema (ro default labels merged under stored `settings`;
  per-quiz sessionStorage key, versioned by `updatedAt` so edits discard stale
  answers; visibility = quiz pillar ∈ site config pillars, like articles),
  POSTs to `/quiz/[slug]/submit` (+server.ts: 256KB cap, sanitize, score,
  `{ redirectUrl }`) → `/quiz/[slug]/rezultat/[resultId]` (band, advice,
  per-dimension bars, then the OPTIONAL email step — result fully visible
  without it; `?/email` action). `/newsletter` (signup action + status page),
  `/newsletter/confirm/[token]`, `/unsubscribe/[token]` (both idempotent GET
  side effects, noindex).
- **Admin**: `/admin/quizzes` (editor-accessible; list + create-by-title like
  articles, per-quiz result counts) and `/admin/quizzes/[id]` — fields +
  form_schema/scoring JSON textareas (server re-validates; failed saves echo
  the texts back so edits survive), live client-side validation panel, an
  on-demand MultiStepForm preview (persist:false, doesn't store results),
  publish/unpublish (persist first), latest-20 results with subscriber email.
  `/admin/subscribers` (admin-only, already in `ADMIN_ONLY_SECTIONS`): search,
  consent badges with source, confirmed flag, CSV at
  `/admin/subscribers/export.csv` (+server.ts inside the (shell) group so the
  guard's section rule applies).
- **Seed**: `pnpm db:seed` also upserts a published ro sleep screening quiz
  `/quiz/evaluare-somn` (11 questions / 3 steps incl. a likert-batch, 3
  dimensions, 3 bands; content in `modules/quiz/seed-quiz.ts`), idempotent,
  tagged `somn` so it is live on BOTH sites.
- **Layout note**: the new dynamic public routes widened `$app/types`'
  `Pathname` union; `resolve(x as Pathname)` no longer typechecks (union
  defeats the overloads). Nav/config hrefs now cast to a single static route
  (`as '/'` / `as '/admin'`) — value is unchanged at runtime.

## Shop (Phase 5)

- **modules/shop** (`apps/web/src/lib/modules/shop/`, split barrels; the server
  barrel is imported from `hooks.server.ts` so the products media-reference
  check registers at boot). `README.md` in the module documents the design.
- **Money is integer cents (bani) everywhere** — DB, services, Stripe,
  metadata. `money.ts` is the ONLY place amounts meet strings:
  `formatCents(4990) → "49,90 lei"` and `parseLeiToCents("49,90") → 4990`,
  both integer/string math (grep-verified: no parseFloat/toFixed/float
  arithmetic anywhere in shop code).
- **Schema** (migration `0007`): `products` (text id, unique slug, name,
  `description_md`, `price_cents` int, currency `ron`, `stripe_product_id`,
  `stripe_price_id`, status `draft|active|archived`, `cover_media_id`
  FK→media set-null, `gallery` jsonb media-id array, `stock` nullable int —
  null = untracked, timestamps), `product_pillars` (join, cascade),
  `orders` (id, email, UNIQUE `stripe_session_id` — the idempotency anchor,
  `stripe_payment_intent`, `amount_total_cents`, currency, status
  `pending|paid|failed|refunded`, `shipping_address` jsonb, created_at),
  `order_items` (order FK cascade, product FK set-null, name+`price_cents`
  snapshot, qty).
- **StripeGateway** (`gateway.ts`): every Stripe API call goes through this
  interface. `getStripeGateway()` (server barrel) returns the REAL gateway
  (`stripe-gateway.ts`) only when `STRIPE_SECRET_KEY` is non-empty; otherwise
  the deterministic in-memory mock (`mock-gateway.ts`, sessions
  `cs_test_mock_N` → `https://checkout.stripe.com/c/pay/cs_test_mock_N`).
  Dev, vitest and e2e all run on the mock (playwright config forces
  `STRIPE_SECRET_KEY=''`), so no test can ever call Stripe.
- **Sync** (`sync.ts`): saving a product in admin upserts the Stripe product
  and creates a new price + archives the replaced one when the amount changed
  (`syncProductToStripe`). Checkout does NOT depend on sync — sessions use
  inline `price_data` snapshotted from our DB rows.
- **Cart**: httpOnly cookie `cart` of `{productId, qty}` lines; pure logic in
  `cart.ts` (add/setQty/remove/count, qty clamped 1–99, max 7 distinct lines
  so the checkout metadata snapshot fits Stripe's 500-char value limit),
  cookie glue in `$lib/server/cart.ts`. Prices are never trusted from the
  cookie — always re-read from the DB. Header badge is server-rendered from
  the layout load (`cartCount` in `App.PageData`; a page load that mutates
  the cart cookie must override it — the checkout success page returns
  `cartCount: 0` because the layout load may read the cookie first).
- **Checkout** (`checkout.ts`): `createCheckoutFromCart` filters the cart to
  visible+purchasable products, drops out-of-stock lines (error if anything
  was dropped: `unavailable-items`), creates the session (RON, shipping
  address collection RO, success `/cos/succes?session_id={CHECKOUT_SESSION_ID}`,
  cancel `/cos`, both from `PUBLIC_SITE_URL`) and the `?/checkout` action on
  `/cos` 303-redirects to the session URL. The cart snapshot travels in
  session metadata (`cart` = JSON `[{i,q,p}]`, built/parsed by
  `buildCartMetadata`/`parseCartMetadata`).
- **Webhook** `POST /api/stripe/webhook`: `verifyStripeEvent` (SDK's offline
  signature check against `STRIPE_WEBHOOK_SECRET`; bad/missing signature →
  400, nothing written). `processStripeEvent`:
  `checkout.session.completed` → insert order + items in a transaction keyed
  on the UNIQUE session id (a duplicate delivery hits the constraint and
  returns `duplicate-session` — exactly one order), decrement tracked stock
  floored at 0 (untracked stays null), send the `order-confirmation` email
  through modules/email with idempotency key `order-confirmation:<orderId>`;
  `charge.refunded` → mark the matching order `refunded`. Unhandled event
  types are acknowledged (`ignored`). Always 200 + `{received, outcome}` for
  verified events.
- **Public routes**: `/magazin` (grid of `active` products tagged to the
  site's pillars — same visibility rule as blog/quiz; out-of-stock badge),
  `/magazin/[slug]` (gallery via `<Img>`, sanitized markdown description
  incl. `media:` refs, qty + add-to-cart form → 303 `/cos`; disabled
  "Stoc epuizat" button when tracked stock is 0), `/cos` (qty edit, remove,
  totals, checkout action), `/cos/succes` (order summary by `session_id`,
  server-side lookup; clears the cart; shows a "processing" state when the
  webhook hasn't landed yet). Nav configs have a `Magazin` entry.
- **Admin** (both admin-role only, already in `ADMIN_ONLY_SECTIONS`):
  `/admin/products` (list + create-by-name) and `/admin/products/[id]`
  (fields, price entered in lei → stored bani via `parseLeiToCents`, status,
  stock, cover/gallery media pickers, pillar checkboxes, Stripe sync status +
  manual re-sync action; every save re-syncs to Stripe when active);
  `/admin/orders` (list, ro status labels) and `/admin/orders/[id]`
  (read-only detail: items, totals, shipping address, Stripe ids).
- **Seed**: `pnpm db:seed` also upserts 3 demo `somn` products (mask 89,90 lei
  stock 25; tea 34,50 lei untracked; light 129,00 lei stock 8) with SVG
  placeholder covers+gallery uploaded to storage by the seed itself (no
  binaries in the repo; fixed ids/keys, idempotent — `seed-products.ts`).
  NOTE: seeding needs MinIO up (it PUTs the SVGs).

## Chat (Phase 6)

- **modules/chat** (`apps/web/src/lib/modules/chat/`, split barrels):
  - `$lib/modules/chat` (universal): `ChatWidget`/`ChatPanel` components, the
    `ChatProvider`/`ChatMessage` types, pure helpers (`selectChatProvider`,
    `validateChatMessage` ≤2000 chars, `capHistory` last 20, `mockReplyFor`)
    and `CHAT_ERRORS` (ro API error copy the widget renders verbatim).
  - `$lib/modules/chat/server`: schema, `handleChatMessage`, token helpers and
    the env-bound `getChatProvider()` singleton. The barrel calls it at module
    init and `hooks.server.ts` imports it, so `CHAT_PROVIDER=anthropic` without
    `ANTHROPIC_API_KEY` refuses to boot (fail fast, never a silent fallback).
- **Providers**: `MockChatProvider` — deterministic keyword-based canned ro
  answers (somn/salut/test keywords + generic fallback, all with the
  no-medical-advice stance), streams word chunks; `AnthropicChatProvider` —
  `@anthropic-ai/sdk`, model `claude-sonnet-5`, `client.messages.stream()`
  yielding text deltas. Selection (`select.ts`, pure): mock by default;
  anthropic ONLY when `CHAT_PROVIDER=anthropic` AND a key is set. Dev, vitest
  and e2e all run on the mock — an ambient key alone never activates the live
  provider (unit-tested; playwright forces `CHAT_PROVIDER=mock` +
  `ANTHROPIC_API_KEY=''` into both preview servers).
- **Personas** (`src/lib/config/personas/{sleep-coach,life-coach}.ts`): ro
  system prompts keyed by the site config's `chatPersonaKey`, resolved via
  `resolvePersona()` (throws on unknown). Prompts take `{ siteName }` at
  runtime — brand strings stay in `config/sites/*`. Both carry: pillar scope
  (sleep: somn only; life: all 9 from `CANONICAL_PILLARS`), a firm
  not-medical-advice stance, off-topic refusal style, and quiz-funnel nudges.
- **Schema** (migration `0008`): `chat_sessions` (text id, `anonymous_token`,
  created_at, `message_count`), `chat_messages` (session FK cascade, role
  `user|assistant`, content, created_at), `chat_rate_limits` (key, count,
  window_started_at — same fixed-window pattern as `login_attempts`).
- **Session ownership**: signed httpOnly cookie `chat_session` =
  `<sessionId>.<anonToken>.<HMAC>` (secret = `BETTER_AUTH_SECRET`). Tampered/
  foreign-secret token → 403; valid token whose session was pruned starts a
  fresh conversation. No expiry claim — retention is row pruning.
- **Rate limiting**: 20 user messages/hour, per session AND per IP
  (`CHAT_RATE_LIMIT`), checked before anything is persisted → 429 with a
  friendly ro message rendered in the widget.
- **API `POST /api/chat`**: thin glue around framework-free
  `handleChatMessage(deps, { message, sessionToken, ip })`. Streams SSE
  `data: {"delta": …}` frames then `{"done": true}`; the assistant message is
  persisted only after the stream is fully consumed; provider history is the
  last 20 stored messages; `maxTokens` 1024. Errors are JSON `{ error }` (ro)
  with 400/403/429. `DELETE /api/chat` clears the cookie ("new conversation").
- **UI**: `ChatWidget` (floating, bottom-right, rendered on all `(public)`
  pages when the site config's `chatWidget` flag is true — both sites: true)
  and `/asistent` full page (`ChatPanel variant="page"`; nav gained an
  `Asistent` entry). Streaming rendering via fetch + SSE parsing, disclaimer
  line above the input (`chat_disclaimer` message), reset button. Conversation
  display is client-local (no history-restore GET endpoint yet — the cookie
  only gives the provider context continuity across widget reopenings).
- **Retention**: `pnpm chat:prune` deletes sessions older than 30 days
  (messages cascade); wire into cron at deploy time. Logic is
  `pruneChatSessions()` (integration-tested).

### Manual end-to-end verification with real Stripe (test mode)

Not run in CI/agent runs — do this by hand when you have keys:

1. In `.env` set `STRIPE_SECRET_KEY=sk_test_…`, restart `pnpm dev` (the real
   gateway is selected only when the key is non-empty).
2. `stripe listen --forward-to localhost:5173/api/stripe/webhook` and copy the
   printed `whsec_…` into `STRIPE_WEBHOOK_SECRET` (restart dev again).
3. Buy something on `/magazin` → Stripe Checkout test card `4242 4242 4242
   4242`, any future expiry/CVC, RO address → you land on `/cos/succes` and
   `stripe listen` forwards `checkout.session.completed` → order appears in
   `/admin/orders` as `plătită`, stock decremented, `email_log` has the
   `order-confirmation` row (dry-run unless Resend is configured).
4. Refund the payment in the Stripe test dashboard → `charge.refunded` flips
   the order to `rambursată`.

## Hardening & launch readiness (Phase 7)

- **Content export/import CLI** (`modules/content/`, node-safe; script
  `apps/web/scripts/content.ts`): `pnpm content export --type article|quiz|product
  --slug X [--out f.json]` produces a SELF-CONTAINED bundle (version 1):
  content fields, pillar SLUGS (ids differ per db), and every referenced media
  row incl. original bytes base64 (cover, gallery, `media:` body refs).
  `pnpm content import f.json` targets the CURRENT env's DATABASE_URL +
  S3_BUCKET and is idempotent by slug: images match by storage key, video
  embeds by provider+external id; a media id collision inserts under a fresh
  uuid and REMAPS the markdown refs + cover/gallery (`remapMediaRefs`).
  Pillars missing in the target db are skipped with a warning (content stays
  visible only where its pillar is active). Stripe catalog ids are NEVER
  imported (they belong to the source account). Import bundles are validated
  by `parseBundle` before anything runs. Second test db `better_test_b` is
  created on demand by the spec (and on fresh volumes by
  `docker/postgres-init`).
- **GDPR surface**:
  - `modules/gdpr/`: cookie-consent banner (`CookieConsent.svelte`, rendered
    by the public layout; cookie `cookie_consent=granted|denied`, ~6 months,
    parsed server-side in the (public) layout load). NO analytics ships; the
    hook point is `analyticsAllowed()` — any future analytics script must gate
    on it (comment in the component marks the spot). Playwright pre-dismisses
    the banner via `storageState` (a fixed overlay would block footer clicks);
    the funnel + home a11y specs clear cookies to exercise it.
  - `modules/pages/`: DB-backed simple pages (`pages` table, migration 0009),
    public at `/pagini/[slug]` (plain markdown render, no media refs), admin
    at `/admin/pages` (editor-accessible: list, create-by-title, edit
    title/body/seo). Seed creates privacy+terms ONLY if missing (`ensurePage`
    — re-seeding never overwrites admin edits). Footer links come from site
    config `footerLinks` (new `SiteConfig` field).
  - **Erasure CLI**: `pnpm subscriber:delete -- --email x@y.ro`
    (`modules/gdpr/erase.ts`): deletes the subscriber, unlinks their quiz
    results (kept as anonymous stats), anonymizes orders (email +
    shipping_address) and email_log (to_email + data) to
    `anonimizat@gdpr.invalid`. Integration-tested; idempotent.
- **Ops hygiene**: `GET /api/health` → 200/503 `{status, checks:{db,storage}}`
  (db `select 1` + storage HeadBucket — HeadObject can't detect a missing
  bucket; each check bounded by a 5s timeout; `$lib/server/health.ts`,
  integration-tested against broken endpoints). Unhandled errors: `handleError`
  in hooks.server.ts logs ONE structured JSON line to stderr
  (`$lib/server/log.ts` — ts/level/errorId/status/method/path/message/stack)
  and the error page shows the correlating errorId. 404s render the existing
  custom error page.
- **A11y**: `e2e/a11y.e2e.ts` (axe via @axe-core/playwright) gates home (incl.
  open consent banner), blog list+article, quiz, product, cart, /asistent and
  the open chat widget at ZERO serious/critical violations, both sites.
  Contrast fixes this required: public `text-(--color-ink)/60` → `/70`, life
  brand darkened `oklch(0.52 0.13 155)` → `oklch(0.45 0.13 155)` (white-on-
  brand ≥ 4.5:1). Keep new muted text at /70 minimum.
- **Performance** (`e2e/perf.e2e.ts`): rendered HTML never contains the
  storage endpoint (originals stay private; `plain/s3://bucket/…` inside
  imgproxy URLs is fine — that's imgproxy's server-side source ref); every
  `<img>` is imgproxy-served AND carries width+height (no CLS — the audit
  fails if the catalog renders zero images, so it can't pass vacuously); zero
  third-party requests on the homepage. **Fonts: system font stack on purpose**
  (no webfonts → nothing to self-host/swap, zero font CLS/latency); if a brand
  font ever lands, self-host it with `font-display: swap` and extend the
  perf spec. **Bundle review (pnpm build, adapter-node)**: client total
  ~446 kB raw; largest chunks 70/53/44/34 kB (≈20/20/14/13 kB gzip — Svelte
  runtime, formcomp, kit runtime); CSS 45 kB (7.7 kB gzip); no chunk is an
  outlier, nothing worth splitting yet.
- **Full-funnel e2e**: `e2e/funnel.ts` (shared impl) instantiated per site by
  `funnel-sleep.e2e.ts` / `funnel-life.e2e.ts` (skip when the project doesn't
  match): health check → home (pillars, consent banner accept persists) →
  footer legal page → pillar page → seeded article → quiz (20/32) → email step
  (both dry-run emails + consent rows asserted in db) → shop (CEAI, the
  untracked-stock product — deliberately not the ones whose stock the shop
  spec asserts) → cart → mock checkout 303 → signed webhook → order row +
  success page + order-confirmation dry-run → chat widget streams the canned
  reply. Global setup now also seeds demo articles + default pages.
- **Docs**: root `DEPLOYMENT.md` (env matrix per site, build/run, migrate+seed,
  R2, imgproxy + Cloudflare cache rule, Stripe webhook, Resend, cron, second
  site, post-deploy verification) and `LAUNCH-CHECKLIST.md` (human-only steps:
  accounts, lawyer review of the seeded legal skeletons, RO e-commerce
  requirements (ANPC/SOL, company id), DNS/TLS, live-Stripe test, Resend DNS,
  content review, ops drills).

## Known gaps / suggested next phases

Every CODE gap this batch set out to close is closed: invoicing + shipping
landed in NEXT-6/7/8, nurture in NEXT-9, chat history restore and media
blurhash in NEXT-10. What remains is the honest gap list at the very END of
this file ("What this batch did NOT do") — human-only launch steps and
deliberate deferrals, each with its reason.

## Key commands (all from repo root)

- `docker compose up -d` — start Postgres + MinIO + imgproxy (`--wait` works, all
  have healthchecks).
- `pnpm storage:init` — create the media bucket (idempotent).
- `pnpm dev` / `pnpm build` — dev server / production build (adapter-node).
- `pnpm lint && pnpm check && pnpm test:unit` — the phase gate; all green.
- `docker compose --profile neon up -d --build` then `pnpm test:neon` — the full
  suite with `DB_DRIVER=neon` over a real WebSocket connection (local
  Neon-protocol proxy; see DEPLOYMENT.md §12). Fails loudly if the proxy is
  down, never skips.
- `pnpm test:e2e` — needs the full compose stack up; builds, then runs playwright
  against two preview servers
  (port 4173 = `SITE_ID=sleep`, 4174 = `SITE_ID=life`); one build serves both because
  `SITE_ID` is read at runtime.
- `pnpm user:create -- --email … --password … --role admin|editor` — create/update
  a staff user in the `DATABASE_URL` database.
- `pnpm chat:prune` — delete chat sessions older than 30 days from the
  `DATABASE_URL` database (wire into cron at deploy time).
- `pnpm media:blurhash` — backfill `media.blurhash` for image rows still at
  null (content imports, pre-NEXT-10 uploads). Idempotent + resumable; skips
  SVGs; exits non-zero while any row stays unfilled. Needs `IMGPROXY_*` +
  `S3_BUCKET` (the tiny source renders come from imgproxy).
- `pnpm content export --type article|quiz|product --slug X [--out f.json]` /
  `pnpm content import f.json [--allow-untagged]` — cross-site content sharing
  (bundle carries media bytes; import is idempotent by slug and targets the
  current env's db+bucket; a bundle whose pillars are all absent from the
  target is refused unless `--allow-untagged`).
- `pnpm content:init` (= `pnpm content import-dir [dir]`) — import every `*.json`
  bundle in a directory. With no argument it imports the active site's
  initial-content directories: `content/common/` then `content/<SITE_ID>/`
  (base overridable with `CONTENT_DIR`). Files import in filename order, so
  `010-`/`020-` prefixes control sequencing; missing directories are skipped.
  `pnpm db:seed` runs this as its last step (after pillars — an import needs
  them to exist) and exits non-zero if any bundle failed. Loader:
  `apps/web/src/lib/modules/content/init.ts` (uses `node:fs`, deliberately NOT
  re-exported from the module index so it stays out of the app bundle).
  Authoring guide: `content/README.md`; `content/examples/article.json` is a
  copyable minimal bundle. A broken file is reported and skipped — it never
  blocks the other bundles.
- `pnpm subscriber:delete -- --email x@y.ro` — GDPR erasure (subscriber row
  deleted, quiz results unlinked, orders/email log anonymized).
- `pnpm launch:check --dev` — deploy preflight against the current env (drop
  `--dev` for a real target env; `--no-probe` skips the imgproxy round trip).
- `pnpm db:status` — applied/PENDING per committed migration for the target db
  (prefers `DIRECT_DATABASE_URL`); non-zero exit while migrations are pending.
- `pnpm db:migrate` / `pnpm db:seed` — for the site in `.env`; for the other site
  prefix e.g. `SITE_ID=life DATABASE_URL=postgres://better:better@localhost:5433/better_life`
  (the host is normalized either way — see the service-hostname note in Env below).
- `pnpm --filter web db:generate` — generate a new migration after schema changes.

## Env & environment quirks

- `.env` lives at the **repo root** (see `.env.example`): `SITE_ID`, `DATABASE_URL`,
  `TEST_DATABASE_URL`, `PUBLIC_SITE_URL`, `DB_PORT`, `BETTER_AUTH_SECRET` (new in
  Phase 1 — better-auth session secret; generate a real one outside dev) and
  `TOKEN_SECRET` (new in FIX-6 — signs consent/chat/upload tokens; must differ
  from the auth secret). Every tooling entry point loads it through
  `scripts/env.ts` → `loadRootEnv()` (`vite.config.ts`, `drizzle.config.ts`,
  `e2e/env.ts` and all six `scripts/*.ts`; dotenv still never overrides real env).
- **Service hostnames are normalized at load time** (`src/lib/config/hosts.ts`,
  unit-tested in `hosts.spec.ts`). The compose stack publishes its ports on the
  DOCKER HOST, so the right spelling depends on where the process runs:
  `localhost` on the host, `host.docker.internal` from a sibling container (agent
  / phase runner). `loadRootEnv()` detects containerhood (`/.dockerenv`, else
  `/proc/1/cgroup`) and rewrites `DATABASE_URL`, `TEST_DATABASE_URL`,
  `S3_ENDPOINT` and `IMGPROXY_URL` accordingly — only those four, and only when
  the host is `localhost`/`127.0.0.1`/`host.docker.internal`, so compose service
  names (`db`, `minio`) and real deployment hosts are never touched. Only the
  host substring is spliced, preserving port/credentials/db/trailing slash
  (`new URL().toString()` would append a `/` and break `${IMGPROXY_URL}/sig/…`).
  Consequence: **`.env` no longer needs editing when moving between host and
  container**, and either spelling works in the committed file.
  `PUBLIC_SITE_URL`/`ORIGIN` are deliberately out of scope — they are the app's
  own origin, not a service it dials.
- Phase 5 env vars: `STRIPE_SECRET_KEY` (**empty in dev/tests → deterministic
  mock gateway**; set `sk_test_…` only for manual verification) and
  `STRIPE_WEBHOOK_SECRET` (any non-empty value for the mock/dev flow; the
  real `whsec_…` from the dashboard or `stripe listen` otherwise). The
  playwright config forces `STRIPE_SECRET_KEY=''` and a fixed e2e webhook
  secret into both preview servers.
- Phase 6 env vars: `CHAT_PROVIDER` (**`mock` is the default** — deterministic
  canned ro answers; dev and all tests run on the mock) and `ANTHROPIC_API_KEY`
  (empty in dev/tests, never required there). `CHAT_PROVIDER=anthropic`
  requires the key at boot — the server refuses to start without it. The
  playwright config forces `CHAT_PROVIDER=mock` + `ANTHROPIC_API_KEY=''` into
  both preview servers; no test can ever reach the Anthropic API.
- Phase 4 env vars: `EMAIL_DRYRUN` (**defaults to true** — record to
  `email_log` instead of sending; only `EMAIL_DRYRUN=false` AND a
  `RESEND_API_KEY` deliver for real; tests/e2e always run dry) and
  `RESEND_API_KEY` (empty in dev). `PUBLIC_SITE_URL` is now also the base for
  links inside emails (confirm/result URLs).
- Phase 2 env vars: `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`
  (`better-base-media`), `S3_REGION`, `IMGPROXY_URL`, `IMGPROXY_KEY`,
  `IMGPROXY_SALT`, plus compose port knobs `MINIO_PORT`, `MINIO_CONSOLE_PORT`,
  `IMGPROXY_PORT`. **Reachability rule**: `S3_ENDPOINT` and `IMGPROXY_URL` must be
  reachable by BOTH the server process and the browser (presigned PUTs and <img>
  fetches go directly from the browser). Both roles sit on the same machine, so
  one value works: `localhost:9000/8888` on the host, `host.docker.internal:9000/8888`
  in an agent container (app/vitest/playwright's chromium run there while
  minio/imgproxy are siblings with host-published ports) — and `loadRootEnv()`
  picks the right one, so `.env` needs no per-environment edit. A prod split (internal S3 endpoint + public imgproxy domain) would need
  separate vars — not needed yet.
- Host port **5433** for Postgres (5432 is occupied by an unrelated container on this
  host). Container port stays 5432.
- **Playwright in this container**: chromium's system libraries were installed
  rootless — debs extracted to `~/chromium-libs`. Before `pnpm test:e2e`, export
  `LD_LIBRARY_PATH=$HOME/chromium-libs/usr/lib/x86_64-linux-gnu:$HOME/chromium-libs/lib/x86_64-linux-gnu`.
  (On a normal machine `npx playwright install-deps` replaces this.)
  The dir does NOT survive a container rebuild — recreate rootless with:
  `mkdir -p /tmp/apt-lists/partial /tmp/apt-cache/archives/partial /tmp/debs`,
  `apt-get update -o Dir::State::Lists=/tmp/apt-lists -o Dir::Cache=/tmp/apt-cache`,
  then in /tmp/debs `apt-get download -o … libnspr4 libnss3 libatk1.0-0
  libatk-bridge2.0-0 libdbus-1-3 libxcomposite1 libxdamage1 libxfixes3
  libxrandr2 libgbm1 libxkbcommon0 libasound2 libatspi2.0-0 libdrm2
  libwayland-server0 libxi6` and `for d in *.deb; do dpkg-deb -x "$d"
  ~/chromium-libs; done` (verify: `ldd …/chrome-headless-shell | grep 'not
  found'` is empty with LD_LIBRARY_PATH set).
- Paraglide output (`src/lib/paraglide/`) is gitignored and regenerated; `pnpm check`
  runs `paraglide:compile` first so it works from a fresh checkout.

## Tests so far

- Unit: config resolver + canonical pillar invariants (`src/lib/config/config.spec.ts`).
- Integration: seed idempotency against `TEST_DATABASE_URL` (`src/lib/db/seed.spec.ts`)
  — drops `public`/`drizzle` schemas and re-migrates fresh each run; requires the
  compose db to be up.
- Unit: role guard decisions (`modules/auth/guards.spec.ts`), rate-limit window
  logic (`modules/auth/rate-limit.spec.ts`).
- Integration (`modules/auth/auth.spec.ts`, TEST_DATABASE_URL, fresh migrate):
  user upsert idempotency, session row on valid login / none on invalid, signup
  rejected. Vitest server project runs with `fileParallelism: false` because
  integration specs reset the shared test database.
- E2E smoke (`e2e/smoke.e2e.ts`): both SITE_IDs — site name in header, exact pillar
  count, active pillar page 200, unknown/inactive pillar 404.
- Unit: imgproxy signing/URL building (`modules/media/imgproxy.spec.ts` — the
  known-signature vector was verified live against the container) and upload
  validation/key slugging (`modules/media/validation.spec.ts`).
- Integration (`modules/media/media.spec.ts`, needs db+minio+imgproxy up):
  presign → PUT fixture (320×200 png from `tests/fixtures/`) → confirm records
  dimensions; wrong-content-type PUT 403s; signed imgproxy URL → 200
  `image/webp`, unsigned/tampered → 403; alt update; reference-check refusal;
  delete removes row + object; video-embed rows.
- E2E media (`e2e/media.e2e.ts`, both SITE_IDs): upload via the library, thumbnail
  actually renders (naturalWidth > 0, i.e. signed imgproxy URL served bytes to a
  real browser), alt edit survives reload, delete removes the card. Global setup
  also creates the bucket and clears the `media` table.
- E2E admin (`e2e/admin.e2e.ts`, both SITE_IDs): anonymous redirect, wrong
  password ×5 then 6th rate-limited, admin login→dashboard→logout, editor 403 on
  admin-only routes. `e2e/global-setup.ts` migrates BOTH site DBs, seeds
  e2e-admin/e2e-editor users and clears `login_attempts`;
  `playwright.config.ts` now injects a per-site `DATABASE_URL` into each preview
  server (derived from the root .env URL by swapping the db name).
- Unit (blog): slug transliteration/collision (`modules/blog/slug.spec.ts`),
  sanitizer XSS vectors + media-ref rendering (`modules/blog/markdown.spec.ts`).
- Integration (`modules/blog/blog.spec.ts`, TEST_DATABASE_URL, fresh migrate,
  all 9 pillars seeded): db slug dedupe, publish lifecycle (publishedAt stamped
  once, drafts invisible via `getBySlug`), pillar visibility against the REAL
  sleep/life config pillar lists (somn-tagged visible on both; nutritie-tagged
  invisible on sleep; untagged invisible everywhere — the SITE_ID=life DoD
  case), pagination, admin search, sitemap listing, `renderArticleHtml` by
  id/key + video rows, media reference check (cover + body refs).
- Integration (seed): `seedDemoArticles` idempotency in `db/seed.spec.ts`.
- E2E blog (`e2e/blog.e2e.ts`, both SITE_IDs): editor uploads a cover
  (own fixture `blog-cover.png` — media.e2e runs in parallel on the same
  library, filenames must not collide), creates/fills/tags an article, preview
  renders, draft 404s publicly and is absent from the sitemap, publish → card
  with real imgproxy-rendered cover on /blog, article page renders body +
  inline image, SEO assertions (title/description/canonical/og:type/og:image/
  twitter card/JSON-LD Article), sitemap entry, pillar landing card, unpublish
  → 404 again. Global setup now clears `articles` before `media`.

- Unit (Phase 4): scoring engine incl. band boundaries and max-score
  (`modules/quiz/scoring.spec.ts`), consent shaping (`modules/crm/consent.spec.ts`),
  token sign/verify incl. expiry boundary and tampering
  (`modules/crm/token.spec.ts`), email templates escaping + skip/retry
  decision (`modules/email/email.spec.ts`).
- Integration (Phase 4, TEST_DATABASE_URL, fresh migrate each):
  email idempotency — dry-run never touches the transport, concurrent same-key
  sends collapse to ONE `email_log` row, error→retry keeps one row
  (`email.spec.ts`); subscriber upsert/merge, double opt-in round trip via the
  URL recorded in the dry-run log, unsubscribe revokes, CSV escaping
  (`crm.spec.ts`); quiz lifecycle, publish gate, answer sanitizing, and the
  funnel — retried `claimQuizResult` yields exactly ONE quiz-result and ONE
  newsletter-confirm log entry, corrected email still delivers, unsubscribe
  after the funnel flips consent (`quiz.spec.ts`); `seedDemoQuiz` idempotency
  (`db/seed.spec.ts`).
- E2E quiz funnel (`e2e/quiz.e2e.ts`, both SITE_IDs): complete the seeded quiz
  (deterministic answers → 20/32, top band), consent checkboxes asserted
  default-unticked, result visible before any email, email step → both
  templates in `email_log` as dry-run, confirm link → `confirmed_at`,
  admin sees subscriber + result row, unsubscribe link revokes; plus footer
  newsletter signup from /blog. Global setup seeds pillars + the demo quiz per
  site db, clears `quiz_results`/`subscribers`/`email_log`, and the preview
  servers force `EMAIL_DRYRUN=true`.

- Unit (Phase 5): cart math incl. clamping and the 7-line cap
  (`modules/shop/cart.spec.ts`), money parse/format round-trips
  (`money.spec.ts`), pure webhook pieces — stock floor at 0, metadata
  build/parse, event shape guards (`webhook-pure.spec.ts`).
- Integration (Phase 5, `modules/shop/shop.spec.ts`, TEST_DATABASE_URL,
  fresh migrate, mock gateway): product CRUD + slug dedupe + unknown pillar
  rejected; **visibility against the real site configs** — somn-tagged
  visible on sleep AND life, nutritie-tagged invisible on sleep (the
  inactive-pillar DoD case), untagged/draft invisible everywhere; Stripe
  sync creates/reuses product + archives replaced price; checkout from cart
  (unavailable lines rejected); webhook happy path — signed
  `checkout.session.completed` → order + items + `email_log` row; tampered
  signature → no order; duplicate delivery → exactly one order; stock
  decrement floors at 0; `charge.refunded` → status flip;
  `seedDemoProducts` idempotency (also re-asserted in `db/seed.spec.ts`).
- E2E shop (`e2e/shop.e2e.ts`, both SITE_IDs, mock gateway): seeded catalog
  with real imgproxy covers, add 2 products, qty edit, cart totals,
  `?/checkout` action 303s to the mock checkout URL, tampered webhook
  signature → 400 + no order, signed webhook → order created, duplicate →
  still one order, stock decrement, success page (summary + cart badge
  cleared), admin order list + detail; separate test: tracked stock 0 →
  disabled "Stoc epuizat" buy button + catalog badge.

- Unit (Phase 6): provider selection incl. fail-fast and ambient-key
  resistance + mock determinism with a fetch spy proving zero network
  (`modules/chat/provider.spec.ts`), session token sign/verify/tamper
  (`token.spec.ts`), fixed-window counters (`rate-limit.spec.ts`), message
  validation + history capping (`validate.spec.ts`), persona resolution per
  site config — sleep→sleep-coach, life→life-coach, prompts differ and carry
  the required stances (`config/personas/personas.spec.ts`).
- Integration (Phase 6, `modules/chat/chat.spec.ts`, TEST_DATABASE_URL, fresh
  migrate, mock provider): streamed reply persists user+assistant rows and
  bumps message_count; signed cookie continues the session; foreign token →
  forbidden with nothing persisted; pruned-session token restarts cleanly;
  provider receives exactly the last 20 messages and the persona system
  prompt; 21st message in the window → rate-limited per session AND per IP,
  window expiry unblocks; prune deletes old sessions + cascades messages.
- E2E chat (`e2e/chat.e2e.ts`, both SITE_IDs, mock provider): open widget →
  disclaimer visible, streamed canned reply renders, reset clears the
  conversation + cookie and a fresh session works; `/asistent` full page
  chats; exhausting the hourly IP budget surfaces the friendly ro 429 message
  in the widget. Global setup clears chat tables (rate counters outlive a
  run).

- Unit (Phase 7): bundle parse/validation + media-ref remapping
  (`modules/content/bundle.spec.ts`), consent cookie helpers incl. the
  analytics hook point (`modules/gdpr/consent.spec.ts`), structured error-log
  formatting (`lib/server/log.spec.ts`).
- Integration (Phase 7): content export→import round trip across TWO
  databases (TEST_DATABASE_URL + better_test_b, created on demand) and TWO
  buckets — article/quiz/product, media bytes land in the target bucket,
  pillar mapping by slug (ids deliberately differ), id-collision remap,
  double import → no dupes, Stripe ids never copied, missing-object export
  refusal (`modules/content/content.spec.ts`); pages service — seed-once
  semantics (re-seed never overwrites admin edits), ro slug dedupe
  (`modules/pages/pages.spec.ts`); GDPR erasure — subscriber deleted, quiz
  result kept but unlinked, orders + email log anonymized, repeat run a no-op
  (`modules/gdpr/erase.spec.ts`); health checks against live AND broken
  db/storage endpoints incl. missing bucket and hung dependency
  (`lib/server/health.spec.ts`).
- E2E (Phase 7): full-funnel per site (`funnel-sleep.e2e.ts` /
  `funnel-life.e2e.ts` — see the Phase 7 section for the walk), axe a11y gate
  (`a11y.e2e.ts` — zero serious/critical on home/blog/article/quiz/product/
  cart/chat), perf gate (`perf.e2e.ts` — imgproxy-only images, width/height
  everywhere, no third-party requests). Playwright pre-dismisses the cookie
  banner via storageState; specs that audit the banner clear cookies first.

## Image delivery is a provider seam; Cloudflare replaces imgproxy (2026-08-19)

Motivation: the Vercel deploy needed one always-on box purely for imgproxy
(decided in NEXT-2, `deploy/imgproxy/fly.toml`). Cloudflare Image
Transformations remove it — R2 already stores the originals and the zone
already fronts the site, so the whole deploy becomes Vercel + Neon +
Cloudflare with no container of ours anywhere. No schema change.

- **The seam.** `imageSources()` no longer knows how to build a URL; it takes
  an `ImageProvider` (`modules/media/image.ts`): `{ name, transforms,
  url(key, opts) }`. Three implementations —
  - `cloudflare.ts` — `/cdn-cgi/image/<opts>/<origin>/<key>`, options emitted
    in a FIXED order (a reordered list is a separate edge-cache entry and a
    separate billed transformation), `metadata=none` always (EXIF/GPS off our
    derivatives), imgproxy's fit modes mapped onto Cloudflare's;
  - `imgproxy.ts` — unchanged signing, now wrapped as a provider;
  - `direct.ts` — the stored original, `transforms: false`.
  Selected by `IMAGE_PROVIDER` (`env.ts`), defaulting to `direct`. Pages,
  components and `ImageSources` are untouched — the swap is one env var.
- **`transforms: false` is honest, not degraded.** `buildSrcset` returns ''
  (N identical URLs would make the browser fetch the largest for nothing) and
  `computeBlurhash` throws rather than downloading a megapixel original.
- **Boot/preflight validate by BUILDING the provider** (`imageProviderFromEnv`
  throws naming the missing vars) instead of a static list — a Cloudflare
  deploy is no longer asked for an imgproxy key. `IMGPROXY_*` therefore left
  `boot: true` in the env matrix. `launch:check` refuses `direct` on a real
  deploy, requires https on both public image origins, and its probe is
  provider-aware: for Cloudflare it asserts the R2 custom domain answers 200
  AND that `format=webp` really comes back as webp — with transformations off
  the endpoint returns the untouched source with a 200, the one failure mode
  that otherwise looks perfectly healthy.
- **SVG safety moved from serve-time to rest** (audit M1 stays closed).
  imgproxy sanitized on every serve; the origin-serving providers hand the
  stored object straight to the browser. So `confirmUpload` now sanitizes the
  SVG (`svg.ts`, sanitize-html with an SVG allowlist: no script, no `on*`, no
  `href`/`xlink:href`), writes the clean bytes back, and sets
  `Content-Disposition: attachment` on the object (`storage.setContentDisposition`,
  a self-copy with `MetadataDirective: REPLACE`). Strictly better than before:
  the dangerous bytes stop existing rather than being cleaned on the way out.
- **Local dev and the whole suite run on `direct`** — imgproxy is behind a
  compose profile (`docker compose --profile imgproxy up -d`) and `dev-run.sh`
  no longer starts it or generates a key/salt. `storage:init`, `db:seed` and
  the e2e global setup call `storage.allowPublicRead()` so MinIO serves
  originals anonymously, exactly as R2's custom domain will (the call is
  best-effort: R2 rejects PutBucketPolicy and says so).
- **Tests.** Provider-agnostic assertions live in `image.spec.ts` (each runs
  against all three providers); `cloudflare.spec.ts` pins the URL grammar and
  `env.spec.ts` the selection rules — all pure, so they need no Cloudflare
  account, zone or domain. `media.spec.ts` no longer needs a transformer: it
  asserts anonymous origin serving + the SVG sanitize/attachment pair, and
  blurhashing runs against a stand-in provider that answers `data:` URLs
  DERIVED from the bytes the test uploaded (a corrupt upload still fails to
  encode, so the corrupt-row and backfill-resumability cases keep their
  meaning). `perf.e2e.ts` audits against whichever provider the env selects
  rather than one hard-coded URL shape.
- **What only a real deploy can prove:** that Cloudflare answers these URLs at
  all. That is precisely what `launch:check`'s probe is for — run it against
  the deployed env.

Docs: DEPLOYMENT.md §1/§2/§5/§6 (§6 rewritten as "Image delivery") and §12
(the Fly decision revised, "no always-on box" in Known limits);
LAUNCH-CHECKLIST accounts/DNS/env/preflight boxes; `.env.example`,
`docker-compose.yml`, PROMPT.md, `deploy/imgproxy/README.md` (now marked
optional), the media README and the run-app skill.

## For the next phase

- No admin stubs remain — `StubPage.svelte` is deleted. Articles, quizzes,
  products and settings are full reference implementations (nav labels are
  paraglide `admin_nav_*` messages).
- Site settings: read them via `await locals.settings()` in any server load
  (one query per request, already wired); client-safe values are on
  `page.data.publicSettings` in the `(public)` layout tree. Add a setting in
  `modules/settings/registry.ts` (+ ro/en messages + a `fieldLabels` entry in
  the admin page) — storage/form/validation/launch-rule all derive from the
  registry. Never put a non-`clientSafe` value into PageData; the exposure
  spec greps the serialized payload.
- The footer legal block (NEXT-4) renders from `page.data.publicSettings`
  (company identification + `legal.anpcSalUrl`/`legal.anpcSolUrl`) — the data
  and the read path exist; nothing renders them yet.
- E2E login: use `login`/`submitLogin` from `e2e/helpers.ts` — they wait for
  the `data-hydrated` marker the root layout sets on `<html>` at mount.
  Filling an input that has a server-echoed `value` attribute BEFORE
  hydration races: hydration resets it (this bit us as a flake). Wait for
  the marker in any new e2e that types into such inputs right after goto.
- Posting to a form action with playwright's `request` API: send
  `accept: text/html`, otherwise SvelteKit negotiates the JSON action
  protocol (HTTP 200 + `{type:'redirect'}` body) instead of a real 303.
- Sending email from a new module: `getEmailSender()` from
  `$lib/modules/email/server`, add a typed template in
  `modules/email/templates.ts`, and pick an idempotency key that is STABLE
  across handler retries (derive it from row ids / consent timestamps, never
  from `new Date()` in the handler). Shop order confirmations (Phase 5) should
  key on the order id.
- The quiz email step treats the result email as TRANSACTIONAL (sent to the
  given address regardless of checkboxes); marketing consents are separate
  records. Keep that split for any future email touchpoint.
- Public content visibility rule (articles AND quizzes): row is published AND
  tagged to a pillar that is in the active site config. Products should follow
  the same pattern.
- To show an image: build `imgSources(row, { w })` in a `load` function
  (server barrel) and pass it to `<Img>` (universal barrel). Never import the
  server barrel from a component.
- Any table that references `media.id` must register a
  `registerMediaReferenceCheck` at module init (see the integration spec for the
  shape) so the library's delete button starts refusing correctly.
- Module barrels: if your module needs $env/db-touching exports AND
  component/client exports, split them `index.ts` + `server.ts` like media does
  (ESLint allows `$lib/modules/<name>/server`).
- New admin-only sections must be added to `ADMIN_ONLY_SECTIONS` in
  `modules/auth/guards.ts`; everything else under /admin is editor-accessible by
  default.
- Chat history restore exists (NEXT-10): `GET /api/chat` returns the
  session's stored messages (bounded, ordered) after `verifySessionToken`;
  the widget restores on mount. Rate limits ride the shared table on
  `history:` keys — a new read-path endpoint should follow that pattern
  rather than consuming the write budget.
- `locals.user` is available in all /admin server code (never null inside the
  shell). Add module schemas to the barrel as before — auth did:
  `export * from '../../modules/auth/schema.ts';`.

## Previously noted

- formcomp warns about `import.meta.env` usage during packaging (harmless under Vite,
  noted for a future minimal fix if it bites).
- `pnpm build` output: `apps/web/build/` (node server); previews use `vite preview`.

## What this batch did NOT do (final gap list, 2026-08-08)

The honest remainder for whoever picks this up. Nothing here was blocked —
each line is either human-only by nature or a recorded, deliberate deferral.
Nothing else is known to stand between this build and a better-sleep launch.

**Human-only launch steps** (the LAUNCH-CHECKLIST boxes; the code side is
done and rehearsed — `docs/LAUNCH-DRY-RUN.md`):

- Lawyer review of the three legal pages — the seeded texts are working
  skeletons, not legal advice.
- Accounts + contracts: registrar/Cloudflare (DNS, R2), Stripe live
  activation, Resend domain verification, Anthropic billing, the Sameday
  business contract, a deploy target (Vercel+Neon or VPS), Fly.io for
  imgproxy.
- DNS + TLS for the site and imgproxy hostnames.
- Cloudflare zone: Image Transformations enabled, and the R2 bucket bound to
  a public custom domain on that same zone (`MEDIA_PUBLIC_BASE_URL`). Both are
  dashboard steps no script can do; `launch:check`'s probe verifies them.
- Live keys/secrets in the prod env + `pnpm launch:check` (non-`--dev`)
  green against it — locally it can only be rehearsed as `--dev` (its job is
  to refuse dev values).
- Company identification, ANPC/SOL links, invoice series and shipping
  prices saved in `/admin/settings` (placeholders refuse launch:check).
- One real LIVE card purchase + refund; one real Sameday AWB generated and
  cancelled — the adapter follows the public API but is unverified against
  a live account until then.
- ANAF: SPV enrollment + qualified certificate; until the `EFacturaSubmitter`
  adapter is implemented against real OAuth credentials, e-Factura XML is
  produced but uploaded to SPV manually.
- One run of migrate + suite against a real (free-tier) Neon project —
  the local wsproxy proves the transport, not Neon's own pooler/TLS
  (DEPLOYMENT §12 "Residual risk").

**Deliberate deferrals** (would be code, consciously not built):

- Automated e-Factura submission — blocked on the human ANAF steps above;
  the seam (`efactura-submitter.ts`) and the hard-fail flag exist. Includes
  the known XML gap: `CountrySubentity` (ISO 3166-2:RO county) is omitted
  because the fiscal snapshot stores flattened address strings — extend the
  snapshot when the adapter lands (`modules/invoice/README.md`).
- A second courier adapter (Cargus etc.) — the `CourierProvider` interface
  is the seam; Sameday is the one implemented.
- better-life real content — the platform boots as life (9 pillars, own
  sequences) but everything beyond `somn` is seed-level; content
  export/import + `content/life/` is the mechanism, filling it is editorial
  work.
- ~~Vercel Image Optimization as an imgproxy replacement — rejected in NEXT-2;
  imgproxy on Fly stays the one always-on box.~~ **Superseded 2026-08-19**:
  `IMAGE_PROVIDER` is a seam and deploys default to Cloudflare Image
  Transformations, so there is no always-on box. Vercel Image Optimization
  stays rejected — it would re-bind image delivery to one host.
- Prod split of `S3_ENDPOINT`/`IMGPROXY_URL` into internal + public pairs —
  not needed while both roles resolve to one reachable host; would need two
  new env vars if a private S3 endpoint ever appears.
- Automated Lighthouse in CI — perf/a11y assertions run in e2e
  (`perf.e2e.ts`, `a11y.e2e.ts`); the checklist keeps a manual Lighthouse
  spot-check at launch.

## Remediation FIX-9 (audit 2026-09-03 P0 #1 + auth/GDPR/headers — batch 2, phase 1)

Closes the authorization, header and account-hardening findings of
`docs/AUDIT-2026-09-03.md` (P0 #1 and the "Auth, GDPR & frontend" P1 block).
Every fix landed test-first — the failing regression precedes its fix in
`git log` — and the table-driven authz spec makes the admin surface
closed-by-construction.

**Closed by FIX-9:**

- **P0 #1 encoded-path guard bypass** — `handleAdminGuard` now keys on
  `routeIdPathname(event.route.id)` (route groups stripped; null route → no
  guard, the 404 answers), never on the un-decoded `url.pathname`; the
  session lookup for `/api/invoices/` + `/api/shipments/` moved to the same
  basis. Hook-level harness in `src/hooks.server.spec.ts` (enters kit's
  request store via `@sveltejs/kit/internal/server`, runtime-resolved
  specifier because the entry's published types are not a module) + raw-fetch
  e2e against the built app (`e2e/security.e2e.ts`).
- **Defense in depth** — `requireStaff`/`requireAdmin` in `$lib/server/forms`
  (anonymous → 401, editor on admin-only → 403, narrowed return replaced
  every `locals.user!`); called FIRST in every admin action and every
  `+server.ts` under `/admin/**` and `/api/shipments/**`;
  `createEntityAction` takes `require: 'staff' | 'admin'`.
  `src/routes/admin-authz.spec.ts` is a MANIFEST the spec cross-checks
  against `import.meta.glob` both ways — adding an admin route/action
  without declaring who may call it fails the suite. NOTE: anonymous is now
  401 (was 403) on orders/export and the shipment label; the two old
  assertions conflated unauthenticated with under-privileged and were
  updated deliberately.
- **Security headers + CSP, enforced** — static half in `kit.csp`
  (vite.config.ts: `script-src 'self' 'strict-dynamic'`, `style-src 'self'
  'unsafe-inline'`, `object-src 'none'`, `base-uri 'self'`, mode auto);
  runtime env-derived half appended per-response by `handleSecurityHeaders`
  (FIRST in the sequence) from `$lib/server/security-headers.ts`: `img-src`
  'self' data: + media origin (MEDIA_PUBLIC_BASE_URL or S3-derived) +
  IMGPROXY_URL/CF_IMAGE_BASE_URL origins, `connect-src` 'self' + analytics
  host + S3_ENDPOINT origin on ADMIN routes only, `frame-src` the two
  sanitizer-allowlisted video hosts, `form-action 'self'
  https://checkout.stripe.com` (Chrome enforces it on the checkout 303),
  `frame-ancestors 'none'`; plus nosniff, referrer-policy
  strict-origin-when-cross-origin, x-frame-options DENY, permissions-policy,
  HSTS when PUBLIC_SITE_URL is https, `cache-control: private, no-store` on
  /admin. Proven on the preview build by e2e (`e2e/security.e2e.ts` +
  `armCspGuard`/`assertNoCspViolations` in `e2e/helpers.ts`, wired into
  chat/media/analytics-consent/shop): form-action enforced in BOTH
  directions from a real page (a post to a foreign origin is refused
  pre-flight with a `securitypolicyviolation`; a post to the Stripe checkout
  origin navigates — the navigation is stubbed with `page.route`, real
  Stripe is never contacted) while shop.e2e.ts asserts the checkout 303
  `Location` under the same header; chat streaming; admin upload (presign +
  PUT to the bucket); consent-gated analytics injection; and a real PNG
  cover with a blurhash from the app's own encoder rendering its data:-URL
  placeholder, then dropping it via the JS-attached load listener — all with
  zero violations. Two things learned the hard way: (a) Playwright routes
  only the FIRST request of a redirect chain, so a test that lets the
  browser follow the checkout 303 reaches real checkout.stripe.com — never
  do that; (b) Svelte 5 server-renders `onload={}`/`onerror={}` on media
  elements as inline replay attributes (`onload="this.__e=event"`) that
  `script-src` blocks under the nonce policy — attach such listeners in an
  `$effect`, never as markup (Img.svelte is the reference). Seeded demo
  covers are SVGs and SVGs never get a placeholder, so blurhash checks need
  a raster row. Dev caveat: SvelteKit strips 'strict-dynamic' in dev —
  validate CSP on `pnpm build && pnpm preview` only.
- **Editor scoping** — `pages` joined `ADMIN_ONLY_SECTIONS` (the WHOLE
  section: it is the legal surface — terms/privacy/cookies — so per-slug
  rules that a new legal page could miss were rejected); quiz editor load
  branches on role: admins get `latestResultsWithEmail`, editors get
  `latestResults` with `email: null` (same shape, PII never queried).
- **Login hardening** — second sliding-window counter keyed `email:<email>`
  (20/h, `EMAIL_LOGIN_RATE_LIMIT`) consumed atomically next to the 5/15min
  IP+email counter; either cap → 429; success clears both. Sessions:
  `expiresIn` 12 h, `updateAge` 1 h (was better-auth's 7 rolling days).
  Racing spec: 25 parallel attempts, 25 distinct IPs, one email → exactly
  20 admitted.
- **admin_audit** (migration 0020) — append-only at the DB level (same
  reject-triggers as invoices; TRUNCATE deliberately possible for test
  harnesses), written via `recordAdminAudit` after success in: login,
  subscriber CSV export, monthly orders/invoices zip export (target =
  month), media delete, nurture toggle, legal-page save.
- **Erase completeness** (migration 0021) — webhook lowercases
  `customer_details.email` at write; the email sender normalizes `to` once
  (log row + transport agree); `eraseSubscriberData` matches
  `lower(orders.email)` / `lower(email_log.to_email)` (expression indexes
  `orders_email_lower_idx`, `email_log_to_email_lower_idx`, declared in the
  drizzle schemas) and nulls `email_log.error` (SMTP replies can quote the
  address).

**Not done, validated for the next batch:** TOTP for the `admin` role.
Validated against better-auth 1.6.23 in `node_modules`: the `twoFactor`
plugin exists (`better-auth/plugins`, `two-factor/` dist entry) and exposes
`auth.api.verifyTOTP` (endpoint `/two-factor/verify-totp`) — the intended
design is the plugin on `createAuth` + server-side `auth.api.verifyTOTP` in
the login form action (no `/api/auth` mount needed). Needs its own phase:
schema additions (twoFactor table + user fields), enrollment UI, login-form
second step.

**Migrations note (for FIX-16):** 0020/0021 create indexes on
`admin_audit` (new, empty) and `orders`/`email_log` via the normal
in-transaction path. On today's data sizes that is fine; the
out-of-transaction `CREATE INDEX CONCURRENTLY` path the pipeline phase
establishes should adopt `orders_email_lower_idx`/
`email_log_to_email_lower_idx` as its first candidates if tables grow
before it lands.

**Known limit (accepted):** a redirect or error thrown by a HOOK (the
guard's 303 to `/admin/login`, its 403) is materialized by SvelteKit outside
the `sequence`, so `handleSecurityHeaders` never sees it — the 303 carries
no security headers at all. Its body is empty and it sets nothing, so there
is nothing to protect; every RENDERED response (pages, the 404/403 error
pages, endpoints) goes through the hook. Turning hook-thrown redirects into
hook-built responses was rejected: kit answers data requests
(`__data.json`) and JSON action posts with a redirect *payload*, not a 303,
and a hand-built 303 would break client-side navigation into /admin once
the 12 h session lapses.

**Verification (builder run 2026-09-03):** `pnpm lint && pnpm check &&
pnpm test:unit` green (apps/web 847 passed, 4 skipped — the pre-existing
`driver-parity` suite that only runs with `NEON_WS_PROXY`); `pnpm db:migrate`
+ `db:status` clean on a FRESH database (22 applied) and on a POPULATED one
brought to 0019 first via a journal copy truncated to 20 entries, seeded
with `db:seed`, then given 500 mixed-case `orders` + 500 `email_log` rows
before 0020/0021 applied (expression indexes present, `admin_audit`
UPDATE/DELETE rejected by the trigger); `DEPLOY_TARGET=vercel pnpm build`
green; `pnpm test:e2e` (build + both preview sites) green: 89 passed, 0
failed, 0 flaky across the sleep and life projects; `pnpm test:neon`
(the same unit suite under `DB_DRIVER=neon` through the compose proxy,
driver-parity included) green: 851 passed, 0 skipped.

**New env vars:** none. **New tables:** `admin_audit`. **New migrations:**
`0020_wonderful_pretty_boy.sql`, `0021_odd_green_goblin.sql`.

## Remediation FIX-10 (audit 2026-09-03 P0 #2 + #3, shop P1/P2 money & stock — batch 2, phase 2)

Money after the first payment. Closes the two refund P0s, the pending-order
P1, quantity-vs-stock P1 and the three small shop P2s of
`docs/AUDIT-2026-09-03.md`. Migration `0022_damp_santa_claus` (additive:
`orders.refunded_cents` backfilled from status, new `pending_refunds`, the
one-storno-per-invoice unique index replaced by a plain index + a `BEFORE
INSERT` trigger bounding Σ storno gross ≤ original). No new env vars. One
new setting key: `shop.allowAllPaymentMethods` (boolean, off, server-only).

**Closed by FIX-10:**

- **P0 #2 partial refund processed as a full one** —
  `handleChargeRefunded` reads `charge.amount` / `amount_refunded`
  (cumulative). Partial → `orders.refunded_cents = greatest(current,
  amount_refunded)`, a `refund-partial` trail event with the amounts, status
  stays `paid`, NO storno, fulfillment and the AWB untouched (the customer
  keeps the goods). Full → today's path plus `refunded_cents`; the storno
  reverses the whole invoice or only the REMAINDER after earlier partial
  stornos (`issueStornoForOrderInTx` locks the original row, sums what is
  reversed, and issues a single negative line at the original rate for
  anything short of the full negation — exact line negation is kept for the
  full case). Admin `/admin/orders/[id]` `?/stornoPartial` (admin-only, in
  the authz manifest) reverses `refunded_cents − Σ stornos` via
  `issuePartialStornoForOrder`; the operator types no amount, so the fiscal
  document cannot disagree with the money Stripe recorded. Work queue: a
  partially refunded order stays in `action` with a "rambursare parțială"
  badge; the detail page shows the refunded amount and the button with the
  exact amount it will reverse. `listOrders` aggregates stornos in subqueries
  (several per invoice now) and exposes `reversedCents` + `fiscalIncomplete`
  — ONE SQL definition shared by the `invoice-missing` filter and the badge
  (refunded with stornos short of the invoice counts as incomplete).
  `partialStornoLineAmounts` (vat.ts) is the only computed storno line: VAT
  extracted from the refunded gross with the same half-up rule, negated,
  integer bani, `0 - x` so a 0 % rate yields 0 not -0.
- **P0 #3 refund before its order lost** — an unmatched `charge.refunded`
  is recorded in `pending_refunds` (PK payment intent; charge id, charge
  amount, cumulative refunded amount, received/matched at, order id) and
  acknowledged as `refund-pending` (still exactly-once via the ledger).
  `createOrderFromSession` consults the row for its intent: a pending FULL
  refund creates the order `refunded` (invoice + storno, fulfillment
  `cancelled`, no stock taken, no confirmation email, no nurture); a
  PARTIAL one creates it `paid` with `refunded_cents` and the event, then
  proceeds normally. Both handlers take a transaction-scoped advisory lock
  on the payment intent (`pg_advisory_xact_lock(hashtext(…))`), so the
  refund and its session converge in either order AND under a concurrent
  race (`refunds.spec.ts` races them with `Promise.all`). Matched rows are
  pruned by the retention sweep after the 90-day ledger window
  (`pruneMatchedPendingRefunds`, `RetentionSweepResult.pendingRefundRows`);
  UNMATCHED rows are never swept — they surface in an amber "Semnale
  Stripe" box on `/admin/orders`. A refund with no payment intent at all
  stays `refund-unmatched` (nothing to key it on). `shop.spec`'s old
  `refund-unmatched` assertion for a refund with no order was asserting the
  bug and now expects `refund-pending` (said so in the commit).
- **P1 pending orders are a dead end** — the confirmation email and the
  nurture trigger fire ONLY for a `paid` order (a pending one is not paid
  yet; refunded/failed never will be). New handlers:
  `checkout.session.async_payment_succeeded` flips `pending → paid` in the
  `runOnce` shape (invoice, then email + nurture post-commit; `payment-
  succeeded` event) and, arriving BEFORE `completed`, creates the order paid
  from the session it carries (the later `completed` is a duplicate
  session); `checkout.session.async_payment_failed` marks it `failed`,
  restores the reserved stock (`stock + qty` in SQL, tracked products; NOT
  for an oversold order — its decrement was clamped so the true reservation
  is unknown, the trail says so), cancels fulfillment, and arriving first
  creates the order `failed` with no stock taken. A result for an
  already-settled order is `payment-already-settled`. Card-only default:
  sessions are created with `payment_method_types: ['card']` unless
  `shop.allowAllPaymentMethods` is on (`paymentMethodTypesFor`,
  `CheckoutSessionInput.paymentMethodTypes`, sent verbatim by the real
  gateway — captured through the fetch seam in `stripe-gateway.spec`).
  DEPLOYMENT §7 lists the four subscribed events and the default;
  LAUNCH-CHECKLIST has the events + a partial-refund rehearsal box.
- **P1 quantity vs stock** — `CartLine.maxQty` (tracked stock, null =
  untracked) and `available` now includes `qty ≤ stock`;
  `createCheckoutFromCart` refuses with `unavailable` and a detail naming
  the count (`Name (max N)`, language-neutral, rendered verbatim by `/cos`);
  `?/setQty` and the product page `?/add` clamp the line through the pure
  `clampLineToStock` (zero stock keeps the line at 1 and flagged, never
  silently deleted); `/cos` caps the qty input at the stock, shows
  "(maxim N buc.)" and a "redu cantitatea" line message.
- **P2 absolute stock write racing the webhook** — `updateProduct` gained
  `expectedStock` (optimistic `WHERE stock = loaded`; 0 rows →
  `stock-changed` with the current value, the WHOLE save incl. the retag
  rolls back) and `stockDelta` (`stock = stock + N` in SQL, tracked only).
  The product form posts the loaded value as a hidden guard, writes the
  absolute field only when the operator actually changed it, gains an
  "adaugă în stoc (relativ)" field, and re-bases its buffer on the saved
  stock. `stock.spec.ts` races both against a real webhook decrement:
  the absolute save is refused or lands harmlessly first (final stock is
  the sold-down value either way, never a phantom unit); the relative
  restock adds exactly N.
- **P2 completed session without a cart** — logged at error level with
  session id, amount, currency and intent; still an `empty-cart` ledger row
  (logged once, not on redelivery), listed for the admin
  (`listEmptyCartEvents`) in the same "Semnale Stripe" box.
- **P2 shipping display name / ETA unbounded** — registry `maxLength`
  (name 60, ETA 40; new validator code `too-long` + message) on the four
  shipping text keys; `shippingDisplayName` trims at Stripe's 100 as the
  last line of defense (60 + 40 + the parentheses would be 103).

**Deferred / noted:**

- The async-payment handlers were written as part of the webhook rewrite
  in `91596a1` (the P0 #3 fix reshaped `createOrderFromSession` and the
  post-commit path they share) and their spec (`async-payments.spec.ts`)
  followed in `d91b0f9`; the card-only registry key, checkout wiring and
  gateway parameter in that spec were test-first (`8a0d9cc`). The two P0
  regressions and the admin storno action are strictly test-first.
- No new e2e (the phase lists none); the audit's P2 "e2e gaps" for partial
  refund / async payment stay open for a later phase. The existing suite
  was re-run (see verification).
- **Migrations note (for FIX-16):** 0022 drops `invoices_storno_of_uq` and
  creates `invoices_storno_of_idx` + `pending_refunds_matched_at_idx`
  in-transaction (small tables today); the `refunded_cents` backfill is one
  `UPDATE … WHERE status = 'refunded'`. Adopt the out-of-transaction index
  path if `invoices` grows before it lands.
- Advisory locks are transaction-scoped (`_xact_`), so they are released at
  commit and safe behind a transaction-mode pooler (Neon's pooled endpoint)
  — verified under `DB_DRIVER=neon` in the verification run.

**New:** table `pending_refunds`; column `orders.refunded_cents`; setting
`shop.allowAllPaymentMethods`; order-event kinds `refund-partial`,
`payment-succeeded`, `payment-failed`; webhook outcomes `refund-partial`,
`refund-pending`, `payment-succeeded`, `payment-failed`,
`payment-already-settled` (and `order-created` now carries `status`);
invoice errors `nothing-to-storno`, `storno-exceeds-original`; services
`issuePartialStornoForOrder`, `reversedCentsFor`, `partialStornoLineAmounts`,
`clampLineToStock`, `paymentMethodTypesFor`, `listUnmatchedRefunds`,
`listEmptyCartEvents`, `pruneMatchedPendingRefunds`; admin action
`stornoPartial`; product-form fields `stockLoaded` / `stockDelta`; e2e
reset truncates `pending_refunds` with the order tables.

**Verification (builder run 2026-09-03):** `pnpm lint && pnpm check &&
pnpm test:unit` green from the repo root (apps/web 98 files, 886 passed,
4 skipped — the pre-existing `driver-parity` suite that only runs with
`NEON_WS_PROXY`; +33 new tests across `refunds.spec.ts`,
`async-payments.spec.ts`, `stock.spec.ts`, `vat.spec.ts`,
`orders-page.spec.ts`, `stripe-gateway.spec.ts`, `efactura.spec.ts`,
`retention.spec.ts`); `pnpm test:neon` green (98 files, 890 passed, 0
skipped — the advisory locks and `tx.execute` run through the WebSocket
driver); `pnpm db:migrate` + `db:status` clean on a FRESH scratch database
(23 applied) and on a POPULATED one brought to 0021 via a truncated journal
copy and seeded with 503 orders (73 refunded) plus an invoice + full storno
pair before 0022 applied — every refunded order backfilled to its total,
no non-refunded row touched, `invoices_storno_of_uq` gone,
`invoices_storno_of_idx` + `invoices_storno_bounded` present, a raw storno
past the original refused, `pending_refunds` present;
`DEPLOY_TARGET=vercel pnpm build` green; `pnpm test:e2e` (build + both
preview sites) green: 89 passed, 5 skipped, 0 failed across the sleep and
life projects. Test-first order in `git log`: d2c92f9 (P0 #2/#3 specs) →
91596a1 (fix); 7a7f553 (partial storno amounts) → dad5e28; 2bd9c0b (admin
storno action) → 281f569; d91b0f9 (card-only, stock, race, caps) → 8a0d9cc.

**Re-verification (builder run 2026-09-04, fresh context):** gate green from
the repo root (apps/web 98 files, 886 passed, 4 skipped — the `driver-parity`
suite gated on `NEON_WS_PROXY`); `pnpm test:neon` 98 files, 890 passed, 0
skipped; `pnpm db:migrate` + `db:status` clean on a FRESH scratch database
(23 applied) and on one brought to 0021 through a trimmed journal copy and
seeded with 503 orders (72 refunded), an invoice + full storno pair and a lone
invoice before 0022 ran — all 72 refunded orders backfilled to their total, no
other row touched, `invoices_storno_of_uq` gone, `invoices_storno_of_idx` +
`invoices_storno_bounded` present, and the trigger refused a raw storno past
the original, a one-ban overshoot after two partial stornos that exactly reach
the invoice, and a second full storno of an already reversed invoice;
`DEPLOY_TARGET=vercel pnpm build` green; `pnpm test:e2e` (build + both
preview sites) 89 passed, 5 skipped, 0 failed. Test-first proven, not just
ordered: the P0 spec exactly as committed in d2c92f9, run against the code at
102bfd7 (schema and migration in, webhook fix 91596a1 not yet applied), fails
6 of 7 tests — `refund-marked` where `refund-partial` is expected,
`refund-unmatched` where `refund-pending` is expected, `refundedCents` 0
after a full refund — while the session-first control passes on both.

**New env vars:** none. **New tables:** `pending_refunds`. **New
migrations:** `0022_damp_santa_claus.sql`.

## Remediation FIX-11 (audit 2026-09-03 P1 shop & shipping, P2 courier call in the transaction — batch 2, phase 3)

A deliverable AWB, a self-healing sync, no dead ends. Closes the four
shipping P1s (Sameday adapter, shipment-sync starvation, courier-cancelled
AWB, status classification by substring) and the P2 "courier call inside the
shipment transaction" of `docs/AUDIT-2026-09-03.md`. Migration
`0023_shipment_lifecycle` (additive: `shipments.awb` nullable, new
`next_sync_at` / `error_count` (default 0) / `last_error`; the one-row-per-
order `shipments_order_id_uq` replaced by the PARTIAL
`shipments_order_id_active_uq` on `status not in ('cancelled','failed')`
plus a plain `shipments_order_id_idx`). No new env vars, no new settings.

**Closed by FIX-11:**

- **P1 Sameday adapter cannot produce a deliverable AWB** — Checkout
  sessions enable `phone_number_collection`; the webhook persists
  `customer_details.phone` into `shippingAddress.phone` (erasure already
  nulls the jsonb); `createShipmentForOrder` returns a typed
  `missing-recipient-data` (detail = the missing fields among phone, county
  = Stripe `state`, city, line1) BEFORE any courier call; the adapter sends
  the phone, takes the county from the address `state` only (no city
  fallback), sends `clientInternalReference` = order id, and every failure
  carries Sameday's bounded response body (`samedayFailure`, 600 chars) so
  the operator reads the actual reason on the order page. Admin: the error
  names the fields (localized) and links to a new address editor
  (`?/updateShippingAddress`, admin-only, in the authz manifest): trimmed,
  bounded fields, the courier's four required, and a `shipping-address-
  updated` event that names the CHANGED FIELDS only (never values — the
  trail outlives GDPR erasure). The stored phone shows in the address box.
- **P2 courier call inside the transaction** — creation is two-phase:
  (1) claim under the order lock — validate, insert a `creating` row,
  commit; (2) courier call with NO lock held (a NOWAIT lock on the order
  succeeds meanwhile — pinned by test); (3) record under the lock again:
  `registered` (awb, tracking) + the fulfillment walk, or `failed` with the
  courier's reason and an `awb-failed` event (a retry inserts a fresh
  claim; the failed row stays as history). A racing second click finds the
  claim (`created: false`); a claim older than
  `SHIPMENT_CREATING_STALE_MS` (5 min) with no outcome is failed with a
  "check the courier portal by order id" text and replaced. A refund that
  lands while the courier is registering (the claim counts as "nothing left
  the warehouse", fulfillment → cancelled) makes phase 3 cancel the fresh
  AWB with the courier and answer `order-not-shippable` — raced by test
  with a gated courier. `getShipmentForOrder` prefers the live row, else
  the latest replaced one; `applyRefundShipmentInTx` acts on the live row.
- **P1 shipment-sync starvation** — the sync polls only DUE rows
  (`next_sync_at is null or <= now`), oldest-synced first. A throwing
  lookup bumps `last_synced_at`, backs the row off exponentially
  (`syncBackoffMs`: 15 min × 2^(n−1), capped at 24 h), increments
  `error_count`, stores the bounded `last_error`, and writes a
  `shipment-sync-error` event on the order; a successful poll heals the
  row. Pinned with a batch of ONE: the throwing row no longer blocks the
  next one (the pre-fix code re-polled the same row forever). A
  `CourierAuthError` (Sameday login refused, or a 401/403 on a call — the
  adapter forgets its token) flags the row it hit (event + `error_count`,
  no backoff — the credentials are at fault) and ABORTS the run at error
  level; the result and the cron JSON carry `aborted: 'auth'`. The admin
  dashboard (`/admin`, new `+page.server.ts`) shows a "sincronizarea
  eșuează" banner with the count and the latest error text while any
  in-flight row has `error_count > 0` (`shipmentSyncHealth`).
- **P1 courier-cancelled AWB is a dead end** — a courier `cancelled` seen
  by the sync (the refund path closes its row in-tx, so it never reaches
  here) marks the row `cancelled`, writes `awb-cancelled-externally`, and
  steps a `shipped` order back to `packed` — a NEW edge that only
  `SHIPMENT_SYNC_ACTOR` may take (`canTransition(from, to, actor)`;
  `legalTransitions` and the admin transition action stay unchanged, pinned
  in `fulfillment.spec` and `orders-page.spec`). The partial unique index
  lets `createShipmentForOrder` register a replacement (new row, new AWB,
  its own shipping email); the refund rule then cancels the replacement,
  not the old row.
- **P1 status classification by substring** — `classifySamedayStatus`
  classifies on the numeric `statusId` through `SAMEDAY_STATUS_BY_ID`
  first, then on `statusState`/`status`/`statusLabel` through ANCHORED,
  diacritics-folded text rules with explicit negatives first (`nelivrat` →
  in-transit, never delivered; `anulat`, `retur`, `livrat`, `emis|creat`,
  the movement vocabulary), and logs any unknown text at warn level WITH
  the raw payload before mapping it to `in-transit`. `normalizeSamedayStatus`
  keeps its text-only shape. DEPLOYMENT §7 "Shipping" step 5 and the
  LAUNCH-CHECKLIST live-AWB box carry the capture-real-payload procedure
  (token + status curl → `tests/fixtures/sameday/`, extend the table).

**Deferred / noted:**

- `SAMEDAY_STATUS_BY_ID` ships with ONE row (1 = "AWB Emis"): no captured
  Sameday payload exists in this repo and the author would not invent ids.
  The text rules do the classifying until the live-AWB launch step fills
  the table from real answers; the warn line is the cue for each missing
  row.
- The stale-claim takeover can, when the process died AFTER Sameday
  registered the AWB, produce a second AWB at Sameday on the retry. The
  failed row's text and the DEPLOYMENT paragraph say to check eAWB by order
  id (`clientInternalReference`) first; the adapter has no "find by
  reference" call. Accepted for this phase.
- Trail growth is bounded, not zero: a poisoned AWB writes a
  `shipment-sync-error` per retry (≈ 10 in the first week, then daily);
  broken credentials flag one row per hourly run (the batch head) until
  fixed.
- Migrations note (for FIX-16): 0023 drops and creates its indexes
  in-transaction on `shipments` (small today); adopt the out-of-transaction
  path if the table grows before it lands.
- No new e2e (the phase lists none). The existing `settings.e2e` shipping
  flow now carries phone + county, as do every AWB-generating fixture
  (`orders-page.spec`, `shipment-label-route.spec`, `refunds.spec`,
  `shipment.spec`). The audit's e2e gap for a phone-less order stays open.
- `shipment.spec`'s old "a courier failure writes nothing" asserted the
  single-phase design the audit replaced; it now asserts the `failed` row,
  its reason, no transition, no email, and that the retry registers exactly
  one AWB (said so in the commit). Its parking helper touches only in-flight
  rows — setting a replaced row to `delivered` would create a second live
  row under the partial index.

**New:** columns `shipments.next_sync_at`, `error_count`, `last_error`
(`awb` nullable); shipment statuses `creating`, `failed`; order-event kinds
`awb-failed`, `awb-cancelled-externally`, `shipment-sync-error`,
`shipping-address-updated`; `ShippingAddress.phone`; services
`missingRecipientFields`, `REQUIRED_RECIPIENT_FIELDS`,
`updateOrderShippingAddress`, `shipmentSyncHealth`, `syncBackoffMs`,
`SHIPMENT_SYNC_BACKOFF_BASE_MS/MAX_MS`, `SHIPMENT_CREATING_STALE_MS`,
`SHIPMENT_REPLACEABLE_STATUSES`, `classifySamedayStatus`,
`matchSamedayStatusText`, `SAMEDAY_STATUS_BY_ID`, `samedayFailure`
/`samedayFailureMessage`, `CourierAuthError` / `isCourierAuthError`,
`canTransition(from, to, actor?)`, `SHIPMENT_SYNC_ACTOR` now lives in
`fulfillment.ts` (re-exported), `createShipmentForOrder(…, { now })`,
`syncShipmentStatuses(…, { now })`, `ShipmentSyncResult.aborted`,
`cancelShipmentBestEffort` returns the outcome and can close a row; mock
courier `trackFailures`; admin action `updateShippingAddress`, dashboard
`+page.server.ts`; messages for the editor, statuses, events and banner;
`CheckoutSession` created with `phone_number_collection`.

**Verification (builder run 2026-09-04):** `pnpm lint && pnpm check &&
pnpm test:unit` green from the repo root (apps/web 99 files, 923 passed, 4
skipped — the pre-existing `driver-parity` suite gated on `NEON_WS_PROXY`;
+37 new tests across `shipment.spec.ts`, `courier.spec.ts`,
`fulfillment.spec.ts`, `stripe-gateway.spec.ts`, `shop.spec.ts`,
`orders-page.spec.ts`, `shipment-sync-route.spec.ts`,
`dashboard-page.spec.ts`, `admin-authz.spec.ts`); `pnpm test:neon` 99 files,
927 passed, 0 skipped (the two-phase claim, the NOWAIT probe, the gated
courier race and the partial index all run through the WebSocket driver);
`pnpm db:migrate` + `db:status` clean on a FRESH scratch database (24
applied) and on one brought to 0022 through a trimmed journal copy and
seeded with 400 orders / 133 shipments (45 registered, 44 in-transit, 44
cancelled) before 0023 ran — every row kept, `error_count` 0 / `last_error`
and `next_sync_at` null everywhere, `awb` nullable, `shipments_order_id_uq`
gone, `shipments_order_id_active_uq` (partial) + `shipments_order_id_idx`
present, a `creating` claim next to a cancelled row accepted, a second live
row next to a registered one refused (23505), a `failed` row next to a live
one accepted; `DEPLOY_TARGET=vercel pnpm build` green; `pnpm test:e2e`
(adapter-node build + both preview sites) 89 passed, 5 skipped, 0 failed
across the sleep and life projects, the settings.e2e AWB flow included.
Test-first proven, not just ordered: the T1 spec commit (0a140fd) run
against the code before bfec952 fails 8 of 8 new tests (no typed error,
phone dropped, county became the city, body discarded); the T2 commit
(3a49dd7) before 7457711/fabfef7 fails 17 of 17 (no `creating` row within
2 s, no `error_count` column, `nelivrat` read as delivered, no sync-actor
edge, no `CourierAuthError`); the T3 commit (e8d3e4c) before 9fa407a fails 8
of 9 (the retry-from-failed guard already passed on the F2 service).
Sequence in `git log`: 0a140fd → bfec952; 3a49dd7 → 7457711 → fabfef7;
e8d3e4c → 9fa407a; 515d319 docs.

**New env vars:** none. **New tables:** none. **New migrations:**
`0023_shipment_lifecycle.sql`.
