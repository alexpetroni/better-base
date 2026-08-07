# NEXT-1 — Prove the `neon` driver actually works

Context: `docs/NEXT-VERCEL-NEON.md` § "NOT verified — start here", `docs/STATE.md`
§ "Vercel + Neon as a second deployment target", `src/lib/db/client.ts`.

## Problem

The `DB_DRIVER=neon` branch (`@neondatabase/serverless` over WebSockets +
`drizzle-orm/neon-serverless`) has **never opened a connection**. All 427 tests ran over
`pg`. Three specific unknowns were recorded and none is answered:

1. whether the pooler accepts the `SET statement_timeout` this branch issues on connect
   (PgBouncer rejects non-allowlisted startup parameters, which is why it is a `SET`);
2. whether the WebSocket transport survives the integration suite (interactive
   transactions — `db.transaction()` is used by blog, shop and gdpr services);
3. whether the `Db` type cast in `db/client.ts` hides a runtime difference between the
   node-postgres and neon-serverless drivers.

A real Neon account needs a human. That is NOT a reason to ship unverified: the Neon
serverless driver speaks Postgres over a WebSocket proxy, and that proxy runs locally.

## Deliverables

1. **Local Neon-protocol stack**: a `neon-proxy` service in `docker-compose.yml` behind a
   compose **profile** (e.g. `--profile neon`) so the default `docker compose up -d` is
   unchanged, pointing at the existing `db` service. Configure the driver in tests via
   `neonConfig` (`wsProxy`, `useSecureWebSocket=false`, `pipelineConnect=false` as the
   local proxy requires). Document the exact commands in `DEPLOYMENT.md` §12.
2. **`pnpm test:neon`**: runs the FULL unit+integration suite with `DB_DRIVER=neon`
   against that stack. It must be one command, and it must fail loudly (not skip) if the
   proxy is not up.
3. **Answer the three unknowns in code**, not prose:
   - a test asserting `statement_timeout` is actually in effect on a neon-driver
     connection (a query that exceeds it is cancelled), or — if the `SET` is rejected on
     the pooled path — a fix plus a test proving the fallback is safe;
   - the transaction-using services covered under the neon driver, including a rollback
     case (a transaction that throws leaves no rows);
   - a type-level and runtime check that the two drivers expose the surface `Db` claims
     (including `$client.end()`), so the cast cannot rot silently.
4. **Fix whatever this surfaces.** If the driver seam needs changes, change it — that is
   the point of the phase. Keep `DB_DRIVER` unset behaving byte-identically to today.
5. **Pooled-connection reality check**: with the neon driver's 1-connection-per-instance
   default, prove concurrent requests do not deadlock (two parallel transactions against
   the same client complete or queue, never hang) and document the answer.
6. If any behavior can only be verified against real Neon (e.g. their pooler's exact
   parameter allowlist), say so explicitly in `DEPLOYMENT.md` §12 "Known limits" as a
   named residual risk with the command a human should run — do not claim it verified.

## Tests

- New spec: driver parity — the same set of service-level operations (one insert, one
  select with a join, one transaction commit, one transaction rollback, one
  statement-timeout cancellation) asserted identical under `pg` and `neon`.
- Concurrency spec: N parallel writes through the neon client all land, no hang.
- Existing integration suite passes unchanged under `pnpm test:neon`.

## Definition of Done

- [ ] Gate green (`pnpm lint && pnpm check && pnpm test:unit`) with `DB_DRIVER` unset.
- [ ] `pnpm test:neon` green — the full suite, over a real WebSocket connection, zero
      skipped specs.
- [ ] Each of the three recorded unknowns is answered by a passing assertion, and the
      answer is written into `docs/STATE.md`.
- [ ] `docker compose up -d` without the profile is unchanged (no new required env, no new
      always-on container).
- [ ] `DEPLOYMENT.md` §12 documents the local Neon stack, `pnpm test:neon`, and any
      residual risk that genuinely needs a live Neon project.
- [ ] STATE.md updated; work committed.
