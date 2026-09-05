# Architecture

What the codebase is made of and the rules that keep it that way. The
binding product decisions live in `PROMPT.md` (one codebase, one schema, N
databases; pillars are data; site config selects everything brand-specific;
modules as folders behind barrels). This file is the map; the dated history
is `docs/CHANGELOG.md`; how to run things is `docs/RUNBOOK.md`.

## Boundary policy

- **Modules** live under `apps/web/src/lib/modules/<name>/` and own their
  Drizzle schema (`schema.ts`), services and components. Cross-module code
  imports ONLY through the module barrel: `$lib/modules/<name>` (universal,
  safe in components) or `$lib/modules/<name>/server` (server-only: env,
  db, providers). ESLint `no-restricted-imports` enforces it; inside a
  module use relative imports. The one sanctioned exception is
  `../<module>/schema.ts` for FK relations and joins in one shared query
  layer (the ESLint config documents it).
- **Routes stay thin** — they call module services and return their
  results. Every `/admin` server load and action runs behind the hook guard
  (`hooks.server.ts` → `guardAdminPath`, keyed on the RESOLVED route id) and
  `requireAdmin`; `ADMIN_ONLY_SECTIONS` in `modules/auth/guards.ts` is the
  list of editor-forbidden sections.
- **Site config** (`src/lib/config/sites/{sleep,life}.ts`) is the only place a
  brand string, domain, locale set, pillar list or theme token may appear.
  Everything else derives from `getSite()`; anything operator-editable lives
  in `site_settings` (`modules/settings/registry.ts` — storage, form,
  validation and launch rules derive from one registry entry).
- **Providers behind interfaces + a mock**: chat (`ChatProvider`), email
  (`EMAIL_DRYRUN`), payments (Stripe or the in-memory mock gateway when
  `STRIPE_SECRET_KEY` is empty), courier (`CourierProvider`), image delivery
  (`imageProviderFromEnv`: cloudflare / imgproxy / direct), storage
  (S3-compatible; MinIO locally, R2 in production; a separate PRIVATE fiscal
  bucket). Tests never reach a paid service.
- **Data rules**: integer bani everywhere money is stored or computed; fiscal
  records (invoices, e-Factura submissions, order events) are append-only —
  a correction is a new document (storno); every external side effect is
  idempotent on a stable key. Migrations are additive (`docs/MIGRATIONS.md`).
- **Serverless-compatible by construction**: no in-process state that must
  survive a request (settings are a per-request lazy loader; rate limits and
  queues live in tables; the neon driver holds one connection per instance).
  The same build runs on adapter-node and on Vercel; `DEPLOY_TARGET` /
  `VERCEL` only switch the adapter.
- **Observability seams** (FIX-16): every request gets `locals.requestId`
  (`x-vercel-id` or a UUID), echoed as `x-request-id`; errors are one JSON
  line on stderr through `formatServerError` (query params stripped), plus an
  optional `ERROR_REPORT_URL` sink; `/api/health` is liveness (no I/O),
  `/api/health/ready` is readiness (db + storage).

## Request pipeline (`apps/web/src/hooks.server.ts`)

`handleRequestId` → `handleSecurityHeaders` (headers + the env-derived CSP
half; the static half is `kit.csp` in `vite.config.ts`) → `handleCsrf` (kit's
origin check with the RFC 8058 one-click-unsubscribe exemption) →
`handleParaglide` → `handleSettings` (lazy per-request settings loader) →
`handleAdminGuard`. `handleError` logs the structured line and returns
`{ message, errorId, requestId }` to the error page.

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
- **Compose stack** (root `docker-compose.yml`, images pinned): `db`
  (`postgres:16.15`, host port `${DB_PORT:-5433}`; 5432 was taken on this
  host) and `minio` (S3 API on `${MINIO_PORT:-9000}`, console on
  `${MINIO_CONSOLE_PORT:-9001}`). Behind compose profiles, NOT started by a
  plain `docker compose up`: `imgproxy` (`--profile imgproxy`, only for the
  self-hosted image provider) and `neon-proxy` (`--profile neon`, the local
  Neon-protocol proxy for `pnpm test:neon`). Dev credentials have compose
  defaults matching `.env.example`. Locally the image provider is `direct`
  (originals served as-is); production is Cloudflare (`DEPLOYMENT.md` §6).
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

## Modules — the original phase write-ups

The sections below are the write-ups of the phases that built each module,
kept as the reference for what each one owns. Later phases amended details
(image delivery became a provider seam with Cloudflare as the default; the
fiscal bucket is private; the admin guard keys on the route id; the health
endpoint is split): where a sentence here disagrees with `docs/CHANGELOG.md`,
the changelog is right and the code is righter.

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

## Seams and conventions for the next phase

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
