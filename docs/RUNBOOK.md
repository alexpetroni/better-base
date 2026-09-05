# Runbook

Every command an operator or a phase agent runs, what it needs, and the
environment quirks that have cost time. Written against the code as of
FIX-16 (2026-09-05); `docs/CHANGELOG.md` has the history, `DEPLOYMENT.md`
the per-target deploy procedure, `docs/RESTORE.md` the restore drill.

## Local stack

```bash
docker compose up -d --wait            # Postgres 16.15 (host port ${DB_PORT:-5433}) + MinIO (pinned)
docker compose --profile neon up -d --build     # + the local Neon-protocol proxy (pnpm test:neon)
docker compose --profile imgproxy up -d         # + imgproxy — only for IMAGE_PROVIDER=imgproxy
pnpm --store-dir .pnpm-store install   # node_modules links to the repo-local store (see quirks)
pnpm storage:init                      # media bucket (idempotent)
pnpm db:migrate && pnpm db:seed        # schema (lock + SQL + concurrent indexes), then pillars/pages/content
pnpm dev                               # http://localhost:5173, SITE_ID from .env
```

A fresh compose volume creates `better_sleep`, `better_life`, `better_test`
and `better_test_b` (`docker/postgres-init/`). The second site: prefix
commands with `SITE_ID=life DATABASE_URL=postgres://better:better@localhost:5433/better_life`.

## Commands (repo root)

| Command | What / notes |
| --- | --- |
| `pnpm gate` (= `pnpm lint && pnpm check && pnpm test:unit && pnpm audit --prod --audit-level=high`) | The gate. Also CI's `gate` job. The audit step fails on any high/critical advisory in production dependencies; advisories with no upstream fix are accepted by id in `pnpm-workspace.yaml` (`auditConfig.ignoreGhsas`) with the reason in `docs/STATE.md` — never by lowering the level. |
| `pnpm test:e2e` | Builds, runs both preview servers (4173 sleep / 4174 life), playwright. Needs both databases migrated. |
| `pnpm test:neon` | The unit/integration suite on `DB_DRIVER=neon` over the local proxy. |
| `pnpm build` / `DEPLOY_TARGET=vercel pnpm build` | adapter-node (`apps/web/build/`) / adapter-vercel (`.vercel/output`). |
| `pnpm db:migrate` | `scripts/migrate.ts`: advisory lock → `drizzle-kit migrate` → `CREATE INDEX CONCURRENTLY` runner. Prefers `DIRECT_DATABASE_URL`. `docs/MIGRATIONS.md`. |
| `pnpm db:migrate:concurrent` | Only the concurrent indexes (retry after a failed build). |
| `pnpm db:check` | `drizzle-kit check` — journal/snapshot consistency (in the gate). |
| `pnpm db:status` | applied/PENDING per migration; exit 1 while pending (the Vercel Build Command gate). |
| `pnpm db:role-timeout [--timeout=30s]` | `ALTER ROLE current_user SET statement_timeout` — Neon deploy order step; idempotent. |
| `pnpm --filter web db:generate` | New migration from the schema barrel. Review the SQL; large-table indexes go to `concurrent-indexes.ts`. |
| `pnpm db:seed` / `seed:base` / `seed:demo` | Pillars + pages + settings + initial content (`content/common`, `content/<site>`) / the same without demo rows / demo articles, quiz, products (never on production). |
| `pnpm content export|import|import-dir` | Cross-site content bundles (`content/README.md`). `content:init` = import-dir of the site's initial content. |
| `pnpm media:blurhash` | Backfill placeholders; needs a TRANSFORMING provider (`cloudflare` or `imgproxy`) — not `direct`. |
| `pnpm user:create -- --email … --role admin|editor [--name …]` | Prompts for the password (no echo). Piped: `printf '%s\n' "$PW" \| pnpm user:create -- … --password-stdin`. `--password` is refused on a terminal. |
| `pnpm subscriber:delete -- --email …` | GDPR erasure. |
| `pnpm chat:prune` | Retention (the cron route does the same). |
| `pnpm efactura:requeue -- --all \| <invoiceId>` | Put e-Factura submissions parked after 5 failed attempts back in the cron's queue (same write as the order page's "Repune în coada ANAF" button). Fix the cause first (`DEPLOYMENT.md` §7). |
| `pnpm launch:check [--dev] [--no-probe] [--target=node\|vercel] [--allow-mock-providers]` | Preflight: env rules, image + fiscal-privacy probes, site-settings placeholders, and the VAT schedule left by migration 0024 on an upgraded install (fix: Settings → Invoice, confirm, save — `DEPLOYMENT.md` §4). Warnings (`warning:` lines) are advisory. `DEPLOYMENT.md` §2/§12. |
| `bash scripts/backup.sh [--dry-run]` | Nightly backup (dump + bucket sync); env in the script header. |
| `bash scripts/dev-run.sh` / `dev-stop.sh` | Host helper: stack, migrate, seed, build, serve. |

## Cron

Four routes, all `GET`, all behind `Authorization: Bearer $CRON_SECRET`
(503 without the secret): `/api/cron/chat-prune` (daily), `shipment-sync`
(hourly), `nurture-send` (every 15 min), `efactura-submit` (hourly).
`apps/web/vercel.json` schedules them on Vercel (Pro plan for sub-daily
schedules); on adapter-node a machine cron curls them (`DEPLOYMENT.md` §9).
Each declares `maxDuration = 60`. `efactura-submit` parks a document after
5 failed attempts; the order page button or `pnpm efactura:requeue` puts it
back (the statutory 5-day clock does not stop). Backups: `.github/workflows/backup.yml`
nightly 02:23 UTC, or the same script from a VPS cron.

## CI (`.github/workflows/ci.yml`)

`gate` on every PR/push → `migrate` (main, per site from
`deploy/sites.json`, environment `production`, fails closed without the
site's `DIRECT_DATABASE_URL_<SITE>` secret) → `deploy` (`vercel build` +
`vercel deploy --prebuilt --prod` with `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
`VERCEL_PROJECT_ID_<SITE>`). `e2e` runs on PRs, non-blocking. Adding a site
= one entry in `deploy/sites.json` + its secrets. Renovate pins the action
SHAs and images. Node comes from `.node-version` (22).

## Observability

- stderr, one JSON line each: `level:error` lines from `handleError`
  (`errorId`, `requestId`, status, method, redacted path, message, stack —
  Drizzle query params stripped); `kind:request` lines (method, path,
  status, duration, request id) when `LOG_REQUESTS` is on (default on for
  adapter-node, off on Vercel).
- Every response carries `x-request-id` (`x-vercel-id` on Vercel); the error
  page shows it as `Request: …` next to the error id.
- `ERROR_REPORT_URL` (optional): every error line is also POSTed there.
- `/api/health` — liveness, no I/O: `{status, site, commit, chatProvider}`.
  `/api/health/ready` — readiness, `503` when db or storage is down: point
  the uptime monitor and any load balancer here.

## Env & environment quirks

- `.env` lives at the repo root (`.env.example` documents every variable);
  every tooling entry point loads it through `scripts/env.ts` →
  `loadRootEnv()`, which also rewrites the compose-service hosts
  (`DATABASE_URL`, `TEST_DATABASE_URL`, `S3_ENDPOINT`, `IMGPROXY_URL`) to
  `localhost` on the host and `host.docker.internal` inside a sibling
  container. Do not edit `.env` to move between the two.
- **pnpm**: `node_modules` links to the repo-local store — installs need
  `pnpm --store-dir .pnpm-store …` or fail with `ERR_PNPM_UNEXPECTED_STORE`.
- **Do not run prettier on `docs/*.md`** — repo lint runs from `apps/web`;
  prettier reflows prose and has corrupted a list before.
- **Block comments**: a `*/` inside a JSDoc path (`modules/*/token.ts`)
  closes the comment and fails the build.
- `STRIPE_SECRET_KEY` empty = in-memory mock gateway (dev/tests; launch:check
  refuses it for a deploy). `CHAT_PROVIDER` defaults to `mock`;
  `anthropic` requires `ANTHROPIC_API_KEY` at boot. `EMAIL_DRYRUN` defaults
  to true. `COURIER_PROVIDER` defaults to `mock`. Playwright forces all
  mocks into both preview servers.
- `DB_DRIVER=neon` is for Vercel only (one WebSocket per function instance;
  `DB_POOL_MAX` defaults to 1 there, 10 on `pg`); launch:check refuses it on
  the node target. `DB_POOL_CONNECTION_TIMEOUT_MS=15000` on Vercel + Neon.
- `DIRECT_DATABASE_URL` (unpooled) is what migrations, `db:status`,
  `db:role-timeout` and backups use; unset locally.
- Paraglide output (`src/lib/paraglide/`) is generated; `pnpm check` runs
  the compile first.
- Host port 5433 for Postgres (5432 is taken on the dev host).
- **Playwright in the agent container**: chromium's system libraries are
  installed rootless under `~/chromium-libs`; export
  `LD_LIBRARY_PATH=$HOME/chromium-libs/usr/lib/x86_64-linux-gnu:$HOME/chromium-libs/lib/x86_64-linux-gnu`
  before `pnpm test:e2e`. The directory does not survive a container
  rebuild — recreate with `apt-get download` of `libnspr4 libnss3
  libatk1.0-0 libatk-bridge2.0-0 libdbus-1-3 libxcomposite1 libxdamage1
  libxfixes3 libxrandr2 libgbm1 libxkbcommon0 libasound2 libatspi2.0-0
  libdrm2 libwayland-server0 libxi6` and `dpkg-deb -x` each into it.
- Compose containers are siblings of the agent container: reach their
  published ports at `host.docker.internal:PORT`. The host's `pg_dump` may be
  an older major than the server — use `docker compose exec -T db pg_dump`.
- formcomp warns about `import.meta.env` during packaging (harmless).
- The neon driver was proven locally over the wsproxy (`pnpm test:neon`);
  the one-off run against a real Neon project before the first deploy is a
  human step (`DEPLOYMENT.md` §12 "Known limits").
