# Testing

## Layers and how to run them

| Layer | Command | Needs |
| --- | --- | --- |
| Unit + integration (vitest, `server` project) | `pnpm test:unit` (repo root; runs web AND formcomp) | `docker compose up -d` (Postgres + MinIO) and `TEST_DATABASE_URL` in `.env`. Integration specs drop and re-migrate `better_test`, so the server project runs with `fileParallelism: false`. |
| The same suite on the neon driver | `docker compose --profile neon up -d --build` then `pnpm test:neon` | The local Neon-protocol proxy; the setup file fails loudly (never skips) when it is down. |
| E2E (playwright) | `pnpm test:e2e` | The compose stack; builds, then drives two preview servers (4173 = sleep, 4174 = life) on the mock providers with `EMAIL_DRYRUN=true`. Both site databases must be migrated. In this container export `LD_LIBRARY_PATH` for chromium (`docs/RUNBOOK.md`). |
| The gate | `pnpm lint && pnpm check && pnpm test:unit` | What CI's `gate` job runs on every PR/push (`.github/workflows/ci.yml`), plus `db:migrate` on a fresh database, `db:check`, both builds and `launch:check --target=vercel`. |
| One spec while iterating | `cd apps/web && pnpm exec vitest run <path> --reporter=dot` | Keep the full run for the end. |

## Policy (from `PROMPT.md`, binding)

- Every service function with logic has a unit test; anything that touches
  Postgres has an integration test against the compose database.
- Remediation work is test-first: the commit that adds the failing test
  precedes the commit that makes it pass, so `git log` shows the sequence.
  Concurrency and ordering findings get tests that actually race or reorder
  events against the database, never a comment claiming safety.
- Never weaken a test to pass. If an old assertion was wrong, fix it and say
  so in the commit message.
- External services stay mocked: email dry-run, mock chat, Stripe mocked with
  SDK-signed webhook payloads, mock courier, local MinIO. Never the runner's
  own credentials.
- `vitest` runs with `expect.requireAssertions`; a test without an assertion
  fails.

## Gotchas that have cost a session

- E2E login: use `login`/`submitLogin` from `e2e/helpers.ts` and wait for
  the `data-hydrated` marker before typing into server-echoed inputs.
- Form-action requests from playwright's `request` API or curl need
  `accept: text/html`, else SvelteKit answers with the JSON action protocol.
- Playwright does not route redirect targets: never follow the checkout 303
  to Stripe; assert on the `location` header.
- Hook-level tests (`src/hooks.server.spec.ts`) call the real `handle`
  inside SvelteKit's request store; the admin-guard bypass (`/%61dmin/…`) is
  reproduced with a raw request, not a browser.
- Workflow YAML is under test (`migrate-workflow.spec.ts`): job graph,
  pinned action SHAs, the `deploy/sites.json` matrix, the backup matrix.
- `scripts/backup.sh --dry-run` and `scripts/migrate.ts` are exercised by
  spawning them (`backup-script.spec.ts`, `migrate-script.spec.ts` — the
  latter races two migrations against a scratch database it creates and
  drops).

## Inventory as recorded by the build phases

Moved verbatim from the old `STATE.md`; later phases list their tests in
their `docs/CHANGELOG.md` entries.

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
