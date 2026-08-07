# Resume here: Vercel + Neon (branch `feat/vercel-neon`)

Written 2026-08-06 at the end of the session, for whoever picks this up next.
`docs/STATE.md` has the full description of what was built and why; this file
is only "where we stopped and what to do next".

## Where things stand

| | |
| --- | --- |
| `main` | `2a0b878`, pushed. Initial-content directory + service-host normalization. |
| `feat/vercel-neon` | `3bb5cac`. Vercel adapter, Neon driver seam, cron route, docs. **Not merged.** |
| Local services | `docker compose down` was run; volumes `better-base_db-data` / `better-base_minio-data` kept. |

Everything on the branch is env-gated: with `DEPLOY_TARGET`, `DB_DRIVER` and
`CRON_SECRET` unset, the app behaves exactly as it did on `main`. That is why
the existing suite counts as the regression proof.

## Verified vs not

**Verified:** 427 tests green (411 existing + 16 new); `pnpm check` + lint clean;
both `pnpm build` and `DEPLOY_TARGET=vercel pnpm build` succeed (the latter emits
`nodejs22.x` functions, streaming enabled, `maxDuration: 60` on `/api/chat`, and
the cron function); the app driven through the full funnel in chromium with no
JS errors; `/api/cron/chat-prune` answering 401 / 401 / 200 for no-token /
wrong-token / right-token, and 503 with `CRON_SECRET` unset.

**UPDATE 2026-08-07 (NEXT-1):** the paragraph below is DONE locally — the full
suite now runs with `DB_DRIVER=neon` over a real WebSocket connection
(`pnpm test:neon`, local wsproxy behind `docker compose --profile neon`), and
all three unknowns are answered by passing assertions; see `docs/STATE.md`
§ "Neon driver proven" and DEPLOYMENT.md §12. What still needs a human is the
one-off run against a real free-tier Neon project (§12 "Known limits").

**NOT verified — start here:** the `neon` driver has never opened a connection.
Every test ran against Postgres over `pg`. Unknowns worth watching: whether
Neon's pooler accepts the `SET statement_timeout` on connect, whether the
WebSocket transport behaves under the integration suite, and whether the
`Db` type cast in `db/client.ts` hides any runtime difference.

## Next steps, in order

1. **Push the branch** (only copy is this machine):
   `git push -u origin feat/vercel-neon`

2. **Prove the Neon path.** Free Neon project, then from a checkout:
   ```bash
   DIRECT_DATABASE_URL="postgres://…neon.tech/better_sleep?sslmode=require" pnpm db:migrate
   DB_DRIVER=neon DATABASE_URL="…-pooler…" TEST_DATABASE_URL="…-pooler…/better_test" pnpm test:unit
   ```
   No Vercel account needed. This is the highest-value step: it is the one thing
   the branch claims but has not demonstrated.

3. **Decide where imgproxy runs** (Fly / Railway / existing VPS) — Vercel cannot
   host it and the app signs an imgproxy URL for every image. Same
   `IMGPROXY_KEY`/`IMGPROXY_SALT` as the app, plus its own R2 credentials.
   `DEPLOYMENT.md` §12 has the shape. The alternative — a Vercel Image
   Optimization provider — was deliberately skipped because it means refactoring
   `imageSources()` in `src/lib/modules/media/imgproxy.ts`, which every page
   renders through. That is the one change in this area with real regression risk.

4. **Deploy**: R2 bucket + CORS → Vercel project (Root Directory `apps/web`,
   Install Command `cd ../.. && pnpm install --frozen-lockfile`, so pnpm builds
   `packages/formcomp` whose `dist/` is gitignored) → env per §12 → migrate,
   seed, `content:init` → verify `/api/health` and one streamed chat message.

5. **Merge** once it serves traffic. Optional: a GitHub Actions workflow running
   migrations against Neon before Vercel promotes — not written yet.

## Environment gotchas (all cost time this session)

- **pnpm**: `node_modules` links to the repo-local store, so installs need
  `pnpm --store-dir .pnpm-store …` or they fail with `ERR_PNPM_UNEXPECTED_STORE`.
- **Integration tests need the stack**: `docker compose up -d` — including
  **imgproxy**, or the media specs fail with `ECONNREFUSED :8888`.
- **Do not run prettier on `docs/*.md`**. Repo lint runs from `apps/web`, so
  these files were never formatted; prettier reflows unrelated prose and in one
  case turned a continuation line into a list item.
- **`.env` spells services as `host.docker.internal`** and still works on the
  host because `loadRootEnv()` normalizes it (`src/lib/config/hosts.ts`). No
  per-command overrides needed. `localhost` would be the honest value for this
  machine if anything ever bypasses that loader.
- **Block comments**: a `*/` inside a JSDoc path (e.g. `modules/*/token.ts`)
  closes the comment and fails the build.

## Key files on this branch

`apps/web/vite.config.ts` (adapter switch) · `src/lib/db/client.ts` (driver seam)
· `src/lib/server/retention.ts` + `cron.ts` (shared job + auth) ·
`src/routes/api/cron/chat-prune/+server.ts` · `apps/web/vercel.json` ·
`DEPLOYMENT.md` §12.
