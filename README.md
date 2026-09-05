# better-base

One codebase, deployed once per site: **better-sleep** today, **better-life**
next. SvelteKit 2 + Svelte 5, Postgres 16 + Drizzle, Tailwind v4, Paraglide
(ro). Articles, quizzes, a shop with Romanian invoicing and e-Factura, a chat
assistant, newsletters and nurture sequences, all behind an `/admin` that is
part of the app. `SITE_ID` selects the site; everything brand-specific is
data or config, never code.

## Five-minute quickstart

Prerequisites: Node 22 (`.node-version`; 24 also works), pnpm 11 (`corepack
enable`), Docker with compose.

```bash
cp .env.example .env                        # dev defaults; nothing to edit for a first run
docker compose up -d --wait                 # Postgres + MinIO
pnpm --store-dir .pnpm-store install        # builds packages/formcomp via prepare
pnpm storage:init                           # media bucket
pnpm db:migrate && pnpm db:seed             # schema, pillars, pages, initial content, demo rows
pnpm user:create -- --email you@example.com --role admin   # prompts for a password
pnpm dev                                    # http://localhost:5173 — /admin/login with that user
```

The other site: `SITE_ID=life DATABASE_URL=postgres://better:better@localhost:5433/better_life`
in front of `db:migrate`, `db:seed` and `dev`.

## Verify

```bash
pnpm lint && pnpm check && pnpm test:unit   # the gate (integration tests use the compose stack)
pnpm test:e2e                               # builds, then drives both sites in chromium
```

## Where to read next

| | |
| --- | --- |
| `docs/STATE.md` | Where the project is and what comes next (short). |
| `docs/ARCHITECTURE.md` | What exists, module boundaries, seams and conventions. |
| `docs/RUNBOOK.md` | Every command, cron, CI, observability, environment quirks. |
| `docs/TESTING.md` | Test layers, policy, gotchas. |
| `docs/MIGRATIONS.md` | The migration contract. |
| `DEPLOYMENT.md` | Deploying on adapter-node or Vercel + Neon; env matrix. |
| `LAUNCH-CHECKLIST.md` | What a human must do before launch. |
| `docs/RESTORE.md` | Backup and restore. |
| `docs/CHANGELOG.md` | Dated history of every phase. |
| `PROMPT.md` | The engineering constitution every phase is bound by. |

Layout: `apps/web` (the app), `packages/formcomp` (the quiz form library),
`content/` (initial content bundles), `deploy/` (site matrix + imgproxy
config), `scripts/` (backup, host helpers), `.github/workflows/` (gate →
migrate → deploy; nightly backup).
