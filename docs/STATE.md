# STATE — after Phase 0 (Foundation)

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
- **Database**: Postgres 16 via root `docker-compose.yml` (service `db`, host port
  `${DB_PORT:-5433}`; 5432 was taken on this host). A fresh volume auto-creates
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

## Key commands (all from repo root)

- `docker compose up -d db` — start Postgres.
- `pnpm dev` / `pnpm build` — dev server / production build (adapter-node).
- `pnpm lint && pnpm check && pnpm test:unit` — the phase gate; all green.
- `pnpm test:e2e` — builds, then runs playwright against two preview servers
  (port 4173 = `SITE_ID=sleep`, 4174 = `SITE_ID=life`); one build serves both because
  `SITE_ID` is read at runtime.
- `pnpm db:migrate` / `pnpm db:seed` — for the site in `.env`; for the other site
  prefix e.g. `SITE_ID=life DATABASE_URL=postgres://better:better@host.docker.internal:5433/better_life`.
- `pnpm --filter web db:generate` — generate a new migration after schema changes.

## Env & environment quirks

- `.env` lives at the **repo root** (see `.env.example`): `SITE_ID`, `DATABASE_URL`,
  `TEST_DATABASE_URL`, `PUBLIC_SITE_URL`, `DB_PORT`. It is loaded by `vite.config.ts`
  (dotenv, never overrides real env), `drizzle.config.ts`, `scripts/seed.ts`, and the
  vitest setup file. In this agent container all DB hosts are `host.docker.internal`
  (compose containers are siblings); `.env.example` documents `localhost` for humans.
- Host port **5433** for Postgres (5432 is occupied by an unrelated container on this
  host). Container port stays 5432.
- **Playwright in this container**: chromium's system libraries were installed
  rootless — debs extracted to `~/chromium-libs`. Before `pnpm test:e2e`, export
  `LD_LIBRARY_PATH=$HOME/chromium-libs/usr/lib/x86_64-linux-gnu:$HOME/chromium-libs/lib/x86_64-linux-gnu`.
  (On a normal machine `npx playwright install-deps` replaces this.)
- Paraglide output (`src/lib/paraglide/`) is gitignored and regenerated; `pnpm check`
  runs `paraglide:compile` first so it works from a fresh checkout.

## Tests so far

- Unit: config resolver + canonical pillar invariants (`src/lib/config/config.spec.ts`).
- Integration: seed idempotency against `TEST_DATABASE_URL` (`src/lib/db/seed.spec.ts`)
  — drops `public`/`drizzle` schemas and re-migrates fresh each run; requires the
  compose db to be up.
- E2E smoke (`e2e/smoke.e2e.ts`): both SITE_IDs — site name in header, exact pillar
  count, active pillar page 200, unknown/inactive pillar 404.

## For the next phase

- Add module Drizzle schemas as `src/lib/modules/<name>/schema.ts` and re-export from
  `src/lib/db/schema/index.ts` so drizzle-kit and the app share one barrel.
- formcomp warns about `import.meta.env` usage during packaging (harmless under Vite,
  noted for a future minimal fix if it bites).
- `pnpm build` output: `apps/web/build/` (node server); previews use `vite preview`.
