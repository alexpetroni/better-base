# apps/web

The better-base application (SvelteKit 2, Svelte 5 runes, TypeScript
strict). Run it from the repo root — the root `README.md` has the
quickstart, `docs/RUNBOOK.md` every command.

- `src/lib/config/` — site configs (`sites/sleep.ts`, `sites/life.ts`), pillars.
- `src/lib/modules/<name>/` — one folder per feature (schema, services,
  components) behind `index.ts` / `server.ts` barrels.
- `src/lib/server/` — cross-cutting server code: hooks helpers, env matrix,
  launch preflight rules, logging, health, security headers.
- `src/routes/` — thin routes; `/admin` is the CMS; `/api/cron/*` the
  scheduled jobs; `/api/health` liveness, `/api/health/ready` readiness.
- `drizzle/` — committed migrations (`docs/MIGRATIONS.md`).
- `scripts/` — CLI entry points (`node scripts/<name>.ts`; every one loads
  the root `.env` through `scripts/env.ts`).
- `e2e/` — playwright specs against the built preview servers.

`vite.config.ts` picks the adapter (`adapter-node` by default, `adapter-vercel`
when `VERCEL` or `DEPLOY_TARGET=vercel` is set) and bakes the git commit into
the build for `/api/health`.
