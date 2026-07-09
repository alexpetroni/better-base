# STATE — after FIX-8 (frontend a11y / SEO / performance batch)

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

- **Invoicing & shipping**: orders have no invoices (RO legal requirement for
  the business) and no shipping-provider integration (AWB, tracking emails) —
  the most likely next phase, see LAUNCH-CHECKLIST note.
- **Analytics**: nothing ships; wire a privacy-friendly script behind
  `analyticsAllowed()` in `CookieConsent.svelte` + add the cookie-policy
  copy when it lands.
- **Nurture sequences**: only transactional + double-opt-in emails exist; no
  scheduled newsletter/drip sending (needs a queue/cron design decision).
- **Chat history restore**: the widget's conversation is client-local (the
  cookie only carries provider context) — a GET /api/chat could restore it.
- **Media blurhash** column exists but is never populated (needs pixel
  decoding at upload/confirm time).
- **better-life content**: the platform boots as life, but pillar landing
  copy/quizzes/products beyond `somn` are seed-level only; content export/
  import is the mechanism for sharing what already exists.

## Key commands (all from repo root)

- `docker compose up -d` — start Postgres + MinIO + imgproxy (`--wait` works, all
  have healthchecks).
- `pnpm storage:init` — create the media bucket (idempotent).
- `pnpm dev` / `pnpm build` — dev server / production build (adapter-node).
- `pnpm lint && pnpm check && pnpm test:unit` — the phase gate; all green.
- `pnpm test:e2e` — needs the full compose stack up; builds, then runs playwright
  against two preview servers
  (port 4173 = `SITE_ID=sleep`, 4174 = `SITE_ID=life`); one build serves both because
  `SITE_ID` is read at runtime.
- `pnpm user:create -- --email … --password … --role admin|editor` — create/update
  a staff user in the `DATABASE_URL` database.
- `pnpm chat:prune` — delete chat sessions older than 30 days from the
  `DATABASE_URL` database (wire into cron at deploy time).
- `pnpm content export --type article|quiz|product --slug X [--out f.json]` /
  `pnpm content import f.json [--allow-untagged]` — cross-site content sharing
  (bundle carries media bytes; import is idempotent by slug and targets the
  current env's db+bucket; a bundle whose pillars are all absent from the
  target is refused unless `--allow-untagged`).
- `pnpm subscriber:delete -- --email x@y.ro` — GDPR erasure (subscriber row
  deleted, quiz results unlinked, orders/email log anonymized).
- `pnpm db:migrate` / `pnpm db:seed` — for the site in `.env`; for the other site
  prefix e.g. `SITE_ID=life DATABASE_URL=postgres://better:better@host.docker.internal:5433/better_life`.
- `pnpm --filter web db:generate` — generate a new migration after schema changes.

## Env & environment quirks

- `.env` lives at the **repo root** (see `.env.example`): `SITE_ID`, `DATABASE_URL`,
  `TEST_DATABASE_URL`, `PUBLIC_SITE_URL`, `DB_PORT`, `BETTER_AUTH_SECRET` (new in
  Phase 1 — better-auth session secret; generate a real one outside dev) and
  `TOKEN_SECRET` (new in FIX-6 — signs consent/chat/upload tokens; must differ
  from the auth secret). It is loaded by `vite.config.ts`
  (dotenv, never overrides real env), `drizzle.config.ts`, `scripts/seed.ts`, and the
  vitest setup file. In this agent container all service hosts are
  `host.docker.internal` (compose containers are siblings); `.env.example`
  documents `localhost` for humans.
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
  fetches go directly from the browser). In this container that is
  `host.docker.internal:9000/8888` for both, because the app/vitest/playwright's
  chromium all run in the agent container while minio/imgproxy are siblings with
  host-published ports; on a human host machine `localhost:9000/8888` serves both
  roles. A prod split (internal S3 endpoint + public imgproxy domain) would need
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

## For the next phase

- Admin screens land under `src/routes/admin/(shell)/<section>/` — replace the
  stub `+page.svelte` (they render `StubPage.svelte`; the only remaining stub
  is settings). The sidebar entry already exists; nav labels are paraglide
  messages (`admin_nav_*`). Articles, quizzes and products are full reference
  implementations (list + editor + form actions).
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
- Chat has no history-restore endpoint: the widget's message list is
  client-local; the cookie only carries session identity for provider
  context. If a later phase needs it, add a GET to `/api/chat` that returns
  the session's stored messages after `verifySessionToken`.
- `locals.user` is available in all /admin server code (never null inside the
  shell). Add module schemas to the barrel as before — auth did:
  `export * from '../../modules/auth/schema.ts';`.

## Previously noted

- formcomp warns about `import.meta.env` usage during packaging (harmless under Vite,
  noted for a future minimal fix if it bites).
- `pnpm build` output: `apps/web/build/` (node server); previews use `vite preview`.
