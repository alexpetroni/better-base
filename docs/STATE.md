# STATE — after FIX-16 (2026-09-05, branch `feat/vercel-neon`)

Short by design (FIX-16): where the project is and what comes next. The
dated history moved to `docs/CHANGELOG.md`; the map to `docs/ARCHITECTURE.md`;
commands and quirks to `docs/RUNBOOK.md`; tests to `docs/TESTING.md`.

## Where we are

- Feature-complete for a better-sleep launch (NEXT-1…NEXT-10) and through
  remediation batch 2 (FIX-9…FIX-16 against `docs/AUDIT-2026-09-03.md`).
  What remains is human work: accounts, legal texts, the live-provider
  rehearsals and the first ordered deploy (`LAUNCH-CHECKLIST.md`).
- Two deployment targets from one build: adapter-node (VPS + compose-shaped
  services) and Vercel + Neon (`DEPLOY_TARGET=vercel`, `DB_DRIVER=neon`),
  both green under the gate and both builds.
- The path to production is now `ci.yml`: gate → migrate → deploy, per
  site from `deploy/sites.json`; nightly backups in `backup.yml`.

## Next

1. **A human watches the first Actions run after the runner pushes** — the
   sandbox cannot observe GitHub. Wire the secrets, the `production`
   environment and branch protection first (DEPLOYMENT.md §12 "Ordered
   deploy"); then push, and follow gate → migrate → deploy → `/api/health`
   showing the new commit. Until that run is green the pipeline is
   asserted by `migrate-workflow.spec.ts`, not proven.
2. Flip the Vercel project settings §12 lists (automatic production deploys
   OFF, Build Command `pnpm db:status && pnpm build`, Node 22,
   `ENABLE_EXPERIMENTAL_COREPACK=1`, previews on a Neon branch).
3. The real-Neon check before the first deploy (§12 "Known limits") and the
   Cloudflare image provider's first proof (never rehearsed locally —
   `docs/LAUNCH-DRY-RUN.md` note).
4. Seven green nightly backups + one verified restore (`docs/RESTORE.md`).
5. Product gaps deliberately left: `docs/CHANGELOG.md` § "What this batch
   did NOT do" and the P2 items each FIX entry deferred.

## Closed by FIX-16 (audit 2026-09-03)

- **P0 #5 — no gate, no ordering**: `.github/workflows/ci.yml` (`gate` on
  every PR/push with Postgres + MinIO, fresh-db `db:migrate`, `db:check`,
  `test:unit`, both builds, `launch:check --target=vercel`; `e2e` on PRs
  non-blocking; `migrate` needs `gate`, main only, `environment:
  production`, per-site concurrency, `--ignore-scripts --filter web`,
  fails closed; `deploy` needs `migrate`, `vercel pull/build/deploy
  --prebuilt --prod`). `migrate.yml` deleted; `deploy/sites.json` is the
  matrix (sleep entry). DEPLOYMENT §12 rewritten; checklist box added.
- **Ops: PII in the error log** — `redactQueryParams` strips the
  `params:` block from message and stack; `requestId` on the line;
  `handleRequestId` outermost hook (`x-vercel-id` or UUID → `locals`,
  echoed as `x-request-id`, shown on the error page); optional
  `ERROR_REPORT_URL` sink via `@vercel/functions` `waitUntil`;
  `LOG_REQUESTS` request line (default on for adapter-node).
- **Ops: launch:check blesses a mock shop** — empty `STRIPE_SECRET_KEY`
  fails outside `--dev`; `DB_DRIVER=neon` on `--target=node` fails;
  warnings for vercel-without-neon, `DB_POOL_MAX > 2` on neon, no
  `ERROR_REPORT_URL`. `.env.example` `CRON_SECRET` / `DB_POOL_MAX` comments.
- **Ops: `maxDuration`** — verified landed in FIX-13 (four cron routes +
  Stripe webhook export `config = { maxDuration: 60 }`).
- **Ops: no backup/restore** — `scripts/backup.sh` (dump + rclone sync,
  30/90-day retention, fiscal never expires, `--dry-run` under test),
  `backup.yml`, `docs/RESTORE.md` (rehearsed locally: dump → fresh db →
  `db:status` up to date → `launch:check` OK), R2 lifecycle guidance,
  checklist box = 7 green nights + one verified restore.
- **Ops: Neon path edges** — the on-connect `SET` is `applyNeonStatementTimeout`
  (logs, never rejects unhandled); `pnpm db:role-timeout` (`ALTER ROLE
  current_user SET statement_timeout`, idempotent, integration-tested);
  `DB_POOL_CONNECTION_TIMEOUT_MS=15000` documented for Vercel; `/api/health`
  = liveness (no I/O, site + commit + chat kind), `/api/health/ready` =
  readiness (503 on a dead dependency; e2e funnel checks both).
- **P2 migration contract** — `docs/MIGRATIONS.md`; `db:migrate` =
  `scripts/migrate.ts` (polled `pg_try_advisory_lock(hashtext('better-base-migrate'))`
  → `drizzle-kit migrate` → `scripts/migrate-concurrent.ts`); the
  `site_settings.updated_by` index ships through the concurrent path
  (`concurrent-indexes.ts`); `db:check` in the gate. Proven by racing two
  script runs on a fresh scratch database. Note: a BLOCKING advisory lock
  deadlocks against `CREATE INDEX CONCURRENTLY` (the waiter holds a
  snapshot), hence the poll.
- **P2 toolchain pins** — root `engines` `>=22.18 <23 || >=24`,
  `.node-version` 22 (CI `node-version-file`; Vercel set to 22.x by hand),
  `@types/node` 22 in web AND formcomp, formcomp on vite 8 / TS 6 /
  vite-plugin-svelte 7 / kit 2.63 (check + tests green), `pnpm dedupe` (one
  vite, one TypeScript, one `@types/node` in the lockfile),
  `postgres:16.15`, MinIO release tag, actions pinned to SHAs,
  `renovate.json`, `ENABLE_EXPERIMENTAL_COREPACK` + "no `NODE_ENV`"
  documented.
- **P2 health & logs** — above. **P2 secrets on the command line** —
  `user:create` prompts (no echo) or `--password-stdin`; `--password` refused
  on a TTY; runbook lines and `scripts/dev-run.sh` updated.
- **P2 docs** — this split; `docs/NEXT-VERCEL-NEON.md` merged into
  `docs/RUNBOOK.md` and deleted; root `README.md` + `CLAUDE.md`;
  `apps/web/README.md` replaced; imgproxy-era statements corrected in
  `ARCHITECTURE.md` (compose profiles) and flagged in `LAUNCH-DRY-RUN.md`.

Deferred / not done in this phase: the first Actions run and the Vercel
dashboard flips (human, above); no Cloudflare-provider rehearsal (needs a
zone). Nothing in the phase plan was disagreed with.

## Verification (this phase)

Filled in by the final docs commit — see `docs/CHANGELOG.md` for the previous
phases' results.
