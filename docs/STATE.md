# STATE — after FIX-17 (2026-09-05, branch `feat/vercel-neon`)

Short by design (FIX-16): where the project is and what comes next. The
dated history moved to `docs/CHANGELOG.md`; the map to `docs/ARCHITECTURE.md`;
commands and quirks to `docs/RUNBOOK.md`; tests to `docs/TESTING.md`.

## Where we are

- Feature-complete for a better-sleep launch (NEXT-1…NEXT-10) and through
  remediation batch 2 (FIX-9…FIX-16 against `docs/AUDIT-2026-09-03.md`,
  plus FIX-17 — the medium findings of the FIX-12…16 phase reviews).
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

## Closed by FIX-17 (medium findings of the FIX-12…16 reviews, 2026-09-05)

Plan: the FIX-17 phase plan under `docs/fixes/`. Five test-first commit pairs
(`git log`: `test(…)` then `fix(…)`/`feat(…)`). **No migration**, no new env.

- **e-Factura parked rows had no way back** (FIX-12 review) —
  `requeueParkedSubmission({db}, invoiceId, {orderId?})`,
  `requeueAllParkedSubmissions`, `listParkedSubmissionsForOrder` in
  `modules/invoice/submissions.ts` (`UPDATE … SET status='pending',
  attempts=0, next_attempt_at/error/claimed_at=NULL WHERE status='failed'`);
  admin-only `?/requeue` on `/admin/orders/[id]` (button "Repune în coada
  ANAF" under a parked document, audited as `efactura-requeue`, scoped to the
  order's documents, in the authz route manifest); **new script**
  `pnpm efactura:requeue -- --all | <invoiceId>` (root + web
  `package.json`). DEPLOYMENT §7/§9, RUNBOOK, LAUNCH-CHECKLIST updated.
- **Nurture reseed never re-sent a re-added step** (FIX-13 review) —
  `replanSequenceSends` also selects rows cancelled as `replanned` and, when
  the step index exists again, UPDATEs them back to `pending` with the new
  `scheduledAt`/`stepsHash`, `attempts: 0`, `lastError: null` (the unique
  `(enrollment_id, step_index)` index means such a step can never get a
  second row).
- **Chat inactivity timer defeated the retry** (FIX-14 review) — the
  watchdog is two-phase: until the first stream event only a hard cap of
  `firstEventTimeoutMs` = `timeoutMs × (maxRetries + 1) + inactivityMs`
  (55 s by default, under `maxDuration = 60`) is armed, so the SDK's own
  `timeout`/`maxRetries` run as configured; the 15 s inactivity timer is armed
  from the first event on. `chat/README.md` rows corrected.
- **Upload confirm trusted any key** (FIX-15 review) — `confirmUpload`
  returns `not-found` / "not a pending upload" for any key outside
  `PENDING_PREFIX` before touching storage.
- **Request id adopted a client `x-vercel-id` everywhere** (FIX-16 review) —
  `resolveRequestId(headers, random, { onVercel })` adopts the header only
  with `env.VERCEL` set (threaded from `hooks.server.ts`) and only when it is
  a `[A-Za-z0-9:-]{1,128}` token; otherwise a UUID. The old hook assertion
  ("echoes the x-vercel-id") asserted the defect and was replaced.

Deferred / disagreed: nothing. Not in scope and untouched: everything else
in those review verdicts (all rated low or informational).

## Verification (FIX-17)

- `pnpm lint && pnpm check && pnpm test:unit`: green — 131 files, 1245 tests
  passed, 4 skipped (the pre-existing `skipIf(!PROXY)` driver-parity suite).
  One flaky `migrate-script.spec.ts` hook timeout under the full parallel run
  passed on re-run alone (5 s) and in the second full run.
- Builds: adapter-node and `DEPLOY_TARGET=vercel DB_DRIVER=neon` both green.
- Both sites boot from the adapter-node build (`SITE_ID=sleep` / `life`):
  home 200, `/api/health` 200 with the site name; a request carrying
  `x-vercel-id: spoofed` gets a UUID `x-request-id` back.
- `pnpm efactura:requeue` smoke-tested against the dev database: usage error
  and unknown invoice exit 1, `--all` reports the count (0).
