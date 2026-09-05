# Migration contract

How schema changes reach a database — every database: the local compose
ones, `better_test`, and the two production Neon projects. Binding for every
phase (FIX-16, audit 2026-09-03 "Migration contract").

## The rules

1. **Additive only.** A committed migration is never edited; a mistake is
   fixed by a NEW numbered file. Columns are added, never renamed in place
   (add → backfill → switch readers → drop in a later release). Tables are
   never dropped while a deployed build may still read them.
2. **`NOT NULL` needs a `DEFAULT`** (or a two-step: nullable → backfill →
   `SET NOT NULL` in a later file). A `NOT NULL` without a default rewrites
   the table under an exclusive lock and fails on any existing row.
3. **Indexes on tables that may already be large go through the concurrent
   path**, never through a drizzle SQL file: declare them in
   `apps/web/src/lib/db/concurrent-indexes.ts` (`CREATE INDEX CONCURRENTLY
   IF NOT EXISTS …`, name in the statement = `name`). drizzle-kit applies
   every pending file in ONE transaction, where `CONCURRENTLY` is illegal
   and a plain `CREATE INDEX` holds an exclusive lock for the whole build.
   The runner (`scripts/migrate-concurrent.ts`) is idempotent, autocommits
   each statement, drops and rebuilds an INVALID leftover from a failed
   build, and errors (never skips) if the index is still invalid.
   Small/new tables may keep their indexes in the SQL file — the concurrent
   path is for `orders`, `email_log`, `chat_*`, `subscribers`,
   `site_settings` and anything that grows with traffic.
4. **One migrator at a time.** `pnpm db:migrate` is `scripts/migrate.ts`:
   it polls `pg_try_advisory_lock(hashtext('better-base-migrate'))` on a
   dedicated session, runs `drizzle-kit migrate`, then the concurrent
   indexes, then releases. CI's run and a human's run against the same
   database serialize instead of racing DDL (`migrate-script.spec.ts`
   proves two simultaneous runs on a fresh database both succeed). The
   lock is polled, not blocked on: a blocking `pg_advisory_lock` holds a
   snapshot that `CREATE INDEX CONCURRENTLY` would wait for — a deadlock.
5. **Integer money, append-only fiscal records** (NEXT-PROMPT rules): a
   migration never rewrites `invoices`/`invoice_lines`/`order_events`
   rows; corrections are new rows.
6. **Every migration runs on a fresh database AND on a populated one**
   before it merges (the CI gate does the fresh one; the phase author does
   the populated one against their dev database).

## Commands

| Command | What |
| --- | --- |
| `pnpm --filter web db:generate` | Generate the next `apps/web/drizzle/NNNN_*.sql` from the schema barrel. Review the SQL by hand before committing — check rules 1–3. |
| `pnpm db:check` | `drizzle-kit check`: the journal and snapshots are consistent (the CI gate runs it). |
| `pnpm db:migrate` | Lock → SQL files → concurrent indexes. Prefers `DIRECT_DATABASE_URL` (Neon: the unpooled host). |
| `pnpm db:migrate:concurrent` | Only the concurrent indexes (retry after a failed build). |
| `pnpm db:status` | applied/PENDING per file; non-zero while anything is pending — the Vercel Build Command uses it as a gate. |
| `pnpm db:role-timeout` | Pin `statement_timeout` on the connecting role (Neon; DEPLOYMENT.md §12). |

## Where migrations run

- **CI** (`.github/workflows/ci.yml`): the `gate` job migrates a fresh
  Postgres on every PR and push; the `migrate` job (main only, after the
  gate, `environment: production`, one site per matrix entry from
  `deploy/sites.json`) applies to production before `deploy` promotes.
- **A human** from a checkout with the site's `DIRECT_DATABASE_URL`
  exported — the lock makes this safe alongside CI, but do it only when CI
  cannot (first deploy, an incident).
- **Never the Vercel build** — a build is not a deploy; several may run at
  once. The Build Command `pnpm db:status && pnpm build` only refuses to
  build ahead of the schema.

## Checklist for a phase that touches the schema

- [ ] New numbered file; no edit to a committed one; `pnpm db:check` clean.
- [ ] `NOT NULL` columns carry a default (or the two-step).
- [ ] Indexes on large tables declared in `concurrent-indexes.ts`, not in the SQL.
- [ ] `pnpm db:migrate` run on a fresh database and on a populated one.
- [ ] `docs/CHANGELOG.md` entry names the file and any concurrent index.
