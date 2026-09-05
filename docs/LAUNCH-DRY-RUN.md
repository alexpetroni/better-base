# Launch dry run — executed 2026-08-08 (NEXT-10)

A full rehearsal of the operator-facing launch procedure — DEPLOYMENT.md §4
(database), §9 (cron), §11 (post-deploy verification), §12 (cron routes,
deploy order) and every LAUNCH-CHECKLIST item that is automatable — against
the local compose stack, with the complete feature set (invoices, shipping,
analytics, nurture, chat history restore, blurhash). Everything below was
actually executed; outputs are quoted from the run. Steps the walk proved
wrong or missing in the documents were fixed in the same commit (list at the
end).

> **Not rehearsed since (FIX-16 note, 2026-09-05):** this walk ran on the
> `imgproxy` image provider, which was the default at the time. The default
> is now `IMAGE_PROVIDER=cloudflare` (DEPLOYMENT.md §6) and that provider
> has NOT been exercised locally — it needs a real zone with Image
> Transformations enabled, so its first proof is the production
> `launch:check` image probe and step 3 of §11. Also since this run:
> `/api/health` split into liveness + `/api/health/ready`, `db:migrate`
> wrapped in the advisory-lock script, `user:create` prompts for the password.

**Environment**: local docker compose (Postgres 16 on host port 5433, MinIO,
imgproxy, neon-proxy), adapter-node build served by `vite preview` on
4173 (sleep) / 4174 (life), mock Stripe / mock chat / mock courier,
`EMAIL_DRYRUN=true`, `CRON_SECRET` set for the preview servers. Both site
databases were dropped and recreated first, so this is a first-deploy
rehearsal, not a walk over an already-working install.

## 1. Stack + fresh databases

| Step | Command | Result |
| --- | --- | --- |
| Compose stack | `docker compose up -d --wait` | all services healthy |
| Fresh DBs | `DROP DATABASE …; CREATE DATABASE better_sleep / better_life` | created |
| Bucket | `pnpm storage:init` | `Bucket "better-base-media": exists` (idempotent) |

## 2. Per-site setup (DEPLOYMENT §4 / §12 "Deploy order")

Run once with the sleep env (root `.env`), once with
`SITE_ID=life DATABASE_URL=postgres://better:better@localhost:5433/better_life`:

| Step | Command | sleep | life |
| --- | --- | --- | --- |
| Migrate | `pnpm db:migrate` | 20 migrations applied on the fresh DB | same |
| Status | `pnpm db:status` | `up to date (20 migrations applied)` | same |
| Seed | `pnpm db:seed` | 1 pillar, 3 articles, quiz, 3 products, 3 pages, 10 placeholder settings, 3 nurture sequences | 9 pillars, …, 1 nurture sequence |
| Initial content | (runs inside seed = `pnpm content:init`) | `common, sleep: 0 imported, 0 failed` — both directories exist and are empty; the loader skips them, as documented | `common, life: 0 imported, 0 failed` |
| Admin user | `pnpm user:create -- --email … --role admin` | created | created |
| Blurhash backfill | `pnpm media:blurhash` | `filled 0, failed 0` — all seeded media are SVG placeholders, which are correctly excluded (SVGs are served unrasterized; no placeholder applies) | same |

## 3. Preflight

`pnpm launch:check --dev` →
`launch:check — target node, SITE_ID sleep, --dev: OK (site-settings check skipped: --dev)`,
exit 0. The non-`--dev` form is a launch-day step by design: it must fail
against this environment (dev secrets, http origin, placeholder settings) —
that refusal is its job, so a green non-dev run cannot be rehearsed locally.

## 4. §11 walk (both preview servers)

| §11 step | How verified | Result |
| --- | --- | --- |
| 1. `/api/health` | curl on 4173 and 4174 | `200 {"status":"ok","checks":{"db":"ok","storage":"ok"}}` on both |
| 2. `/` renders | curl + marker grep | sleep: cookie banner (`data-testid="cookie-consent"`), legal-page links, ANPC markers present; life: all 9 pillar links render |
| 3. Admin login + upload | curl form-action login (303 → `/admin`, session cookie), then presign → PUT (200) → confirm via `/admin/media/upload` | row confirmed at 320×200 with `blurhash: L.HPf|o3fQo36qa~fQa~w*jufQju`; signed imgproxy thumb answers `200 image/webp`; `ImageSources.placeholder` is a data-URI PNG. Also exercised browser-side by the media e2e |
| 4. Quiz → email | e2e `funnel-sleep` / `funnel-life` / `quiz` specs (see §6) | pass — double-opt-in email recorded in `email_log` |
| 5. Purchase → `plătită` + invoice | e2e `settings.e2e.ts` "a purchase yields a downloadable invoice" + shop specs | pass on both sites — mock-Stripe webhook creates the paid order, invoice numbered in the declared series, PDF/XML downloadable, confirmation email carries the PDF |
| 6. AWB from order page | e2e "shipping is priced from settings, charged, invoiced and shipped with an AWB" | pass on both sites (mock courier — deterministic fake AWB, tracking email in `email_log`) |
| 7. Cron routes | authorized curls with `CRON_SECRET`; unauthorized without | `chat-prune` → `{"sessions":0,…,"retentionDays":30,…}`; `shipment-sync` → `{"polled":0,"updated":0,"errors":0}`; `nurture-send` → `{"claimed":0,"sent":0,…}`; all three answer `401` without the Bearer |
| 8. Consent-gated analytics | e2e `analytics-consent.e2e.ts` (preview servers run with the `PUBLIC_ANALYTICS_*` trio set) | pass — script loads only after accept, stops after "Retrage acordul" |
| 9. Chat restore on reload | `GET /api/chat` without cookie → `{"messages":[]}`; e2e "reloading the page restores the conversation without duplicates" | pass |
| 10. robots/sitemap/404 | curl | `robots.txt` 200, `sitemap.xml` 200, `/nu-exista` 404 |
| 11. `pnpm media:blurhash` for pre-existing rows | nulled the uploaded row's blurhash in SQL, re-ran | first run `filled 1, failed 0` — and the refilled hash is byte-identical to the confirm-time one (deterministic); second run `filled 0, failed 0` (idempotent) |

## 5. Cron scripts (machine-cron form, §9)

`pnpm chat:prune` executes the same `runRetentionSweep()` as the
`/api/cron/chat-prune` route curled above (single implementation — verified
in code, `src/lib/server/retention.ts`); the route invocation stands as the
executed proof for both forms.

## 6. Full e2e as the interactive walk

`npx playwright test` against the freshly built output, two preview servers
(sleep + life): **81 passed, 3 skipped (site-conditional), 0 failed**.
This executes with a real browser everything §11 lists interactively: admin
media upload, quiz + newsletter double-opt-in, mock purchase → invoice →
AWB → tracking email, consent-gated analytics load/unload, chat streaming +
reload restore, a11y and CLS/perf assertions.

## 7. Both deploy targets, both drivers

| Gate | Command | Result |
| --- | --- | --- |
| adapter-node build | `pnpm build` | green (serves the walk above) |
| Vercel build | `DEPLOY_TARGET=vercel pnpm build` | green (see docs/CHANGELOG.md, NEXT-10 entry) |
| pg driver | `pnpm lint && pnpm check && pnpm test:unit` | green |
| neon driver | `docker compose --profile neon up -d` + `pnpm test:neon` | green |

## What the rehearsal proved wrong (fixed in this commit)

1. **§11 was written before invoices, shipping, analytics and the cron
   routes existed** — its purchase step ended at "order appears as
   `plătită`" and it never mentioned AWBs, the scheduled routes, analytics
   consent, chat restore or the blurhash backfill. §11 now covers all of it
   (steps 5–9, 11).
2. **`pnpm media:blurhash` existed in no document** — added to §9
   (on-demand), §12 "Deploy order", §11 step 11 and the LAUNCH-CHECKLIST
   Ops first-deploy bullet. Without it, media imported via `content:init`
   whose bundles predate blurhash would silently never get placeholders.
3. **The checklist's chat smoke item predated history restore** — reloading
   now must keep the conversation; the Final-smoke bullet says so.

## Not rehearsed here (human-only, unchanged in LAUNCH-CHECKLIST)

DNS/TLS, registrar/Cloudflare/Stripe/Resend/Anthropic/Sameday accounts, live
keys, the real-card live purchase + refund, Resend domain verification and
deliverability, the live Sameday AWB, ANAF SPV enrollment, lawyer review of
the legal pages, the non-`--dev` `launch:check` against the prod env, and
the one-time run against a real Neon project (§12 "Residual risk"). These
are exactly the checklist's remaining boxes.
