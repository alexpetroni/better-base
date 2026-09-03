# FIX-16 — Pipeline and operations: CI gate, ordered deploy, redaction, preflight, backups

Audit refs: P0 #5; P1 "Ops & platform" (all five); P2 migration contract, toolchain pins,
health split, secrets on the command line, docs restructure. See
`docs/AUDIT-2026-09-03.md`.

## Problem

The only workflow applies production DDL on every push to `main` with no gate in front
and nothing ordering it against Vercel's promotion; the project's own gate runs only in
the phase-runner. The error log copies Drizzle's failed-query parameters (PII) to stderr
with no request id and no sink. `launch:check` accepts an empty `STRIPE_SECRET_KEY` (mock
gateway in production) and driver/target mismatches. Cron routes and the webhook get their
`maxDuration` in FIX-13 — verify it landed. There is no backup or restore path for the
fiscal documents or the database. The Neon `SET statement_timeout` is `void`-ed and is not a
session guarantee behind PgBouncer. Toolchain versions disagree across CI, Vercel and docs.
`STATE.md` is a 2 400-line append-only file.

## Deliverables

1. **`ci.yml`.** Jobs: `gate` (Postgres 16 + MinIO as services/steps, `CI=true`, a CI env
   block with dev-shaped values; lint → check → `db:migrate` on a fresh DB → `drizzle-kit
   check` → `test:unit` → both builds → `launch:check --target=vercel` against a
   prod-shaped CI env) on every PR and push; `e2e` on PRs, non-blocking; `migrate`
   (`needs: gate`, `main` only, `environment: production`, existing concurrency group,
   `pnpm install --ignore-scripts --filter web` — formcomp is not needed for DDL); `deploy`
   (`needs: migrate`, `vercel pull` / `vercel build --prod` / `vercel deploy --prebuilt
   --prod` with the token/org/project secrets). Move the body of `migrate.yml` in and delete
   it; update `migrate-workflow.spec.ts` to the new structure. Document in DEPLOYMENT §12:
   disable Vercel automatic production deploys (keep previews), Preview on Neon branches,
   the Build Command `pnpm db:status && pnpm build` as belt-and-braces, and the branch
   protection rule. Support N sites: the migrate/deploy jobs run over a matrix read from a
   committed `deploy/sites.json` (site id → secret names), so better-life is one JSON entry.
2. **Log redaction + request id + sink.** `formatServerError` strips the `params:` block
   and stack frames after it for `DrizzleQueryError`; `handle` sets
   `locals.requestId` from `x-vercel-id` or a UUID, echoes `x-request-id`, includes it in
   the error line and the error page; optional `ERROR_REPORT_URL` sink posted via
   `waitUntil` on Vercel (registered in `env-matrix.ts`, warned about in `launch:check`).
   A minimal request log line (method, path through `redactLogPath`, status, duration,
   request id) behind `LOG_REQUESTS=true`, default on for adapter-node.
3. **Preflight rules.** `launch:check` fails on: empty `STRIPE_SECRET_KEY` outside `--dev`;
   `--target=node` with `DB_DRIVER=neon`; warns on `--target=vercel` without `neon`, and on
   `DB_DRIVER=neon` with `DB_POOL_MAX > 2`. Fix the `.env.example` comments (`CRON_SECRET`
   scope, `DB_POOL_MAX` default per driver).
4. **Backups.** `scripts/backup.sh` (nightly `pg_dump --format=custom` of
   `DIRECT_DATABASE_URL` + `rclone sync` of the media and fiscal buckets to a second
   provider, retention 30/90 days) runnable from a scheduled workflow (`backup.yml`,
   secrets documented) or VPS cron; `docs/RESTORE.md` runbook (restore into a fresh Neon
   branch, `rclone copy` back, `pnpm db:status`, `launch:check`, an invoice download);
   R2 lifecycle guidance that never expires fiscal objects; LAUNCH-CHECKLIST box becomes
   "backup green 7 days + one verified restore".
5. **Neon path.** `ALTER ROLE … SET statement_timeout = '30s'` documented in §12 deploy
   order (and shipped as an idempotent script guarded by `current_user`); the on-connect
   `SET` gets a `.catch` that logs; `DB_POOL_CONNECTION_TIMEOUT_MS=15000` recommended on
   Vercel; `/api/health` split into liveness (`/api/health`, no I/O, returns commit + site)
   and readiness (`/api/health/ready`, today's checks, `no-store`), docs updated for the
   uptime monitor and load balancer.
6. **Migration contract.** `docs/MIGRATIONS.md`: additive only, defaults on NOT NULL,
   indexes on large tables via `scripts/migrate-concurrent.ts` (`CREATE INDEX CONCURRENTLY
   IF NOT EXISTS`, idempotent, run after `db:migrate`), `db:migrate` wrapped in a script
   that takes `pg_advisory_lock(hashtext('better-base-migrate'))`; add the missing
   `site_settings.updated_by` index through the concurrent path.
7. **Pins and hygiene.** `engines` at root (`>=22.18 <23 || >=24`), `.node-version` = 22
   used by CI and Vercel, `@types/node` aligned to 22, `ENABLE_EXPERIMENTAL_COREPACK=1` and
   "do not set NODE_ENV" documented for Vercel, formcomp aligned to the web toolchain and
   `pnpm dedupe`, `minio`/`postgres` images pinned, actions pinned to SHAs with a Renovate
   config. `user:create` accepts `--password-stdin` / prompt and refuses `--password` on a
   TTY; runbook lines updated.
8. **Docs restructure.** Split `docs/STATE.md` into `docs/CHANGELOG.md` (dated entries,
   newest first, text unchanged), `docs/ARCHITECTURE.md` ("What exists", seams, boundary
   policy), `docs/RUNBOOK.md` (commands, cron, env quirks, backup/restore — rewritten
   against current code), `docs/TESTING.md`, and a short `docs/STATE.md` (where we are +
   next); merge and delete `docs/NEXT-VERCEL-NEON.md`; a root `README.md` (5-minute
   quickstart) and `CLAUDE.md` (points at `PROMPT.md` and the boundary rules); replace the
   template `apps/web/README.md`; remove imgproxy-era statements the audit lists; note in
   `LAUNCH-DRY-RUN.md` that the Cloudflare provider was not rehearsed locally.

## Tests

- Unit (must FAIL on current code): `formatServerError` on a synthetic `DrizzleQueryError`
  emits no `params:`; the request id round-trips.
- Unit: launch-check matrix for the new rules; `migrate-workflow.spec.ts` asserts the new
  job graph (`migrate` needs `gate`, `deploy` needs `migrate`, matrix over `sites.json`).
- Integration: `/api/health` answers without a DB; `/api/health/ready` 503s when storage is
  unreachable; the advisory-lock migrate script serializes two concurrent runs.
- Script test: `backup.sh --dry-run` prints the exact commands; `RESTORE.md` steps are
  exercised against the local stack (dump → fresh DB → `db:status` current).

## Definition of Done

- [ ] Gate green locally; `ci.yml`/`backup.yml` parse and their job graph is asserted by
      the workflow spec (`migrate` needs `gate`, `deploy` needs `migrate`, matrix over
      `deploy/sites.json`); STATE.md records that a human must watch the first Actions run
      after the runner pushes (the sandbox cannot observe GitHub).
- [ ] `migrate.yml` replaced; DEPLOYMENT §12 describes the ordered path and the Vercel
      settings a human must flip; `deploy/sites.json` exists with the sleep entry.
- [ ] Redaction, request id, preflight rules, health split, backup script + restore doc,
      pins, docs restructure all in place.
- [ ] Both `SITE_ID`s boot; new short STATE.md updated; work committed.
