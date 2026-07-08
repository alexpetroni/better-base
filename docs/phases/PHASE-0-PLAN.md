# Phase 0 — Foundation: workspace, app skeleton, DB, site config

## Objective

A booting SvelteKit app in a pnpm workspace with the module layout, Drizzle +
Postgres wired, the site/pillar config system working for BOTH `SITE_ID`s, and
the lint/typecheck/test toolchain that every later phase (and the runner's gate)
depends on.

## Deliverables

1. **Workspace**: root `package.json` + `pnpm-workspace.yaml` covering `apps/web`
   and `packages/formcomp` (already vendored — wire it in, `pnpm install` must
   succeed; fix its config minimally if needed, do not rewrite it).
2. **apps/web**: SvelteKit 2 + Svelte 5 (runes) + TypeScript strict + Tailwind v4
   (`@tailwindcss/vite`) + Paraglide (base locale `ro`, also `en` configured).
3. **Root scripts** (these exact names — the gate uses them):
   `pnpm lint` (prettier + eslint), `pnpm check` (svelte-check across workspace),
   `pnpm test:unit` (vitest), `pnpm test:e2e` (playwright), `pnpm dev`,
   `pnpm build`, `pnpm db:migrate`, `pnpm db:seed`.
4. **docker-compose.yml** at repo root: `db` (postgres:16, port 5432, volumes) —
   MinIO/imgproxy are added in Phase 2, structure the file to allow that.
5. **Drizzle setup**: `drizzle.config.ts`, `apps/web/src/lib/db/` with client +
   schema barrel that composes module schemas. First schema: `pillars`
   (id, slug, name, description, sort). Generated migration committed.
6. **Site config system**: `src/lib/config/sites/{sleep,life}.ts` + `index.ts`
   resolving from `SITE_ID` (fail fast on missing/unknown). Config shape:
   `{ id, name, domain, locales, pillars: string[], theme: Record<string,string>,
   nav: NavItem[], chatPersonaKey, email: { from, replyTo } }`.
   `src/lib/config/pillars.ts`: the 9 canonical pillar definitions (slug, name,
   ro copy) — sleep, nutrition, movement, stress, relationships, purpose,
   environment, mind, finance (adjust names sensibly, ro-first).
7. **Seed script** (`pnpm db:seed`): seeds the `pillars` table from config for the
   active `SITE_ID` (sleep → 1 row, life → 9), idempotent.
8. **Module layout**: `src/lib/modules/{blog,quiz,shop,chat,email,media,auth}/`
   each with an `index.ts` barrel (empty exports OK for now) and a README one-liner.
   Add an eslint rule (e.g. `import/no-internal-modules` or a boundaries plugin)
   enforcing cross-module imports only via barrels.
9. **Public skeleton**: root layout reading site config (name in header, theme
   tokens as CSS vars, nav rendered from config), homepage placeholder listing the
   active pillars, `/sanatate/[pillar]` placeholder landing per active pillar, 404.
10. **`.env.example`** documenting every var so far (`SITE_ID`, `DATABASE_URL`,
    `PUBLIC_SITE_URL`); your own `.env` uses `host.docker.internal` per PROMPT.md.
11. **`docs/STATE.md`** created.

## Steps

1. Scaffold workspace + app; get `pnpm dev` serving the skeleton.
2. Compose up Postgres; wire Drizzle; write + run the pillars migration; seed.
3. Build the config system and the config-driven layout/homepage.
4. Wire formcomp as a workspace dep; import one trivial component on a `/dev/form`
   test page to prove the integration compiles.
5. Set up eslint/prettier/svelte-check/vitest/playwright and the root scripts.

## Tests

- Unit: config resolver (valid `sleep`, valid `life`, unknown id throws; life's
  pillar list has 9 entries and all exist in the canonical pillar defs).
- Unit: seed logic is idempotent (run twice → same row count) against the test DB.
- E2E smoke: with `SITE_ID=sleep` the homepage renders the site name and exactly
  1 pillar; with `SITE_ID=life`, 9 pillars. (Two playwright projects or a
  parameterized run — both SITE_IDs must be exercised.)

## Definition of Done

- [ ] `pnpm install` clean from a fresh checkout; `pnpm lint && pnpm check &&
      pnpm test:unit` green at repo root.
- [ ] `docker compose up -d db && pnpm db:migrate && pnpm db:seed` works on a
      fresh volume for both `SITE_ID=sleep` and `SITE_ID=life`.
- [ ] `pnpm build` succeeds; `pnpm test:e2e` green, covering both SITE_IDs.
- [ ] No brand string hardcoded outside `config/sites/`.
- [ ] `docs/STATE.md` written; all work committed.
