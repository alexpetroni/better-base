# STATE — after FIX-18 (2026-09-05, branch `feat/vercel-neon`)

Short by design (FIX-16): where the project is and what comes next. The
dated history moved to `docs/CHANGELOG.md`; the map to `docs/ARCHITECTURE.md`;
commands and quirks to `docs/RUNBOOK.md`; tests to `docs/TESTING.md`.

## Where we are

- Feature-complete for a better-sleep launch (NEXT-1…NEXT-10) and through
  remediation batch 2 (FIX-9…FIX-16 against `docs/AUDIT-2026-09-03.md`,
  FIX-17 — the medium findings of the FIX-12…16 phase reviews — and FIX-18,
  the high findings of the 2026-09-05 whole-project review).
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

## Closed by FIX-18 (high findings, launch checklist and the dropped FIX-10 item of the 2026-09-05 review)

Plan: the FIX-18 phase plan under `docs/fixes/`; source: the whole-project
review of 2026-09-05 at `91acdd3`, items 2–6, 8 and 11. Seven test-first
commit pairs (`git log`: `test(…)` then `fix(…)`/`docs(…)`). **No migration,
no new env.** New root script `pnpm gate`; `pnpm audit --prod
--audit-level=high` in the CI `gate` job; `ci.yml`'s preflight step passes
`--allow-mock-providers`.

- **#2 Stale 19 % rate frozen by migration 0024** —
  `autoMigratedVatSchedule(rows)` (settings/service.ts, exported from the
  server barrel): a single `2025-08-01` line carrying exactly the legacy
  `invoice.vatRateBp` value on a row whose `updated_at` still equals the
  legacy row's (the migration copies it; any operator save stamps a new
  one). `settingsLaunchProblems` reports it (so `pnpm launch:check` fails
  outside `--dev`/`--no-probe`); `loadSettingsForAdmin` returns
  `vatScheduleAutoMigrated` and `/admin/settings` shows a warning under the
  field (`settings-warning-invoice.vatStandardRates`). The re-save marker is
  the row's own `updated_at` — no new key, no migration. Upgrade step in
  DEPLOYMENT §4 and RUNBOOK.
- **#3 `launch:check` blessed `EMAIL_DRYRUN=true`** — production-only rule
  next to the mock-provider one: `EMAIL_DRYRUN` other than `false` (unset
  included — the sender defaults to dry-run) is a problem unless
  `--allow-mock-providers` acknowledges a rehearsal. The spec's production
  fixture now reports it; the clean-env cases pass the acknowledgement.
- **#4 No Resend `Idempotency-Key`** — `EmailMessage.idempotencyKey`
  (required) carries the `email_log` key; the Resend transport sends it as
  the `Idempotency-Key` header on every call, so the retry of a row whose
  first attempt timed out after Resend accepted it is the same request.
  `nurture/README.md` states the real guarantee (app-side skip for `sent`
  rows; provider-side dedupe for retried `error` rows inside Resend's 24 h
  window, which the ≈ 21 h retry schedule fits).
- **#5 Vulnerable production dependencies** — `sanitize-html` 2.17.7,
  `@sveltejs/kit` 2.70.3, transitive `postcss` 8.5.28 / `nanoid` 3.3.18;
  advisory payloads are sanitizer regression vectors in `markdown.spec.ts`.
  `image-size` has **no published fix** (see "Accepted advisories" below):
  `media/service.ts` disables every image-size parser outside
  jpg/png/webp/heif/gif/svg (ICNS and JXL included). `pnpm audit --prod
  --audit-level=high` exits 0 and runs in `pnpm gate` and the CI gate.
- **#6 Settings saves unaudited, IBAN unvalidated** — `settings-save` in
  the `AdminAuditAction` union; the save action reads the current values
  first and records one row per save that changed something: actor, group,
  changed keys, and `old → new` for `company.iban` / `company.bank`
  (target e.g. `company: company.iban (company.iban: "" → "RO49…")`); a
  no-op save records nothing. `util/iban.ts` (`ibanMod97`, `normalizeIban`)
  wired as `company.iban`'s `validate` (`invalid-iban`) and `normalize`
  (stored upper case, no spaces — the form the e-Factura
  `PayeeFinancialAccount` needs).
- **#8 Checklist named a deleted workflow and the wrong secret** — the Ops
  box now names `DIRECT_DATABASE_URL_SLEEP`, `VERCEL_PROJECT_ID_SLEEP`,
  `VERCEL_TOKEN`, `VERCEL_ORG_ID` and the `migrate` job inside `ci.yml`;
  `migrate-workflow.spec.ts` asserts the checklist never mentions
  `migrate.yml` or an unsuffixed `DIRECT_DATABASE_URL` secret and that every
  secret it names is read by `ci.yml`/`backup.yml` or declared in
  `deploy/sites.json`.
- **#11 Shipped, partially refunded orders never surfaced** — the one
  shared `fiscalIncomplete` predicate in `shop/webhook.ts` treats a `paid`
  order with `refunded_cents > Σ stornos` as incomplete (queue
  `?f=invoice-missing` and row badge); the detail page's derived badge
  mirrors it.

Test corrections made while closing these (all additive, none weakened):
the launch-check "clean env" cases pass `allowMockProviders` (the fixture
rehearses on dry-run email on purpose); existing `EmailMessage` fixtures
gained the new required field; the settings-save audit cases count rows
relative to a baseline because `admin_audit` is append-only by trigger.
Noticed, not changed (out of scope): SvelteKit 2.70 deprecates
`kit.csrf.checkOrigin` in favour of `csrf.trustedOrigins` — a build-time
warning only.

### Accepted advisories (`pnpm-workspace.yaml` → `auditConfig.ignoreGhsas`)

- **GHSA-w3rx-r6r6-pgpr** (image-size ≤ 2.0.2, ICNS infinite loop, high) and
  **GHSA-5p2g-fcmc-qvqq** (image-size ≤ 2.0.2, JXL/HEIF infinite loops,
  high). The advisories name `>= 2.0.3` as fixed, but the registry's latest
  release is 2.0.2 (checked 2026-09-05; `pnpm view image-size versions`) —
  there is nothing to bump to. Mitigation in code: `disableTypes(...)` in
  `media/service.ts` turns off every parser the upload gate cannot admit,
  so ICNS and JXL bodies (detection is by magic bytes, not by the declared
  mime) are never parsed. **Residual:** the HEIF parser stays on because
  `image/avif` is an allowed upload — a crafted HEIF/AVIF body from a
  logged-in editor could still spin the confirm request until the platform
  timeout. Uploads are staff-only; the probe is wrapped in try/catch but a
  loop is not an exception. Remove the ids the day image-size ships a fix.
- Below the gate's level and left in place, both transitive with no
  in-range fix path: **GHSA-67mh-4wv8-2f99** (esbuild 0.18.20 dev-server
  CORS, moderate — via `drizzle-kit` → `@esbuild-kit/*`; a dev-only code
  path, `better-auth` pulls drizzle-kit as a runtime dep) and
  **GHSA-pxg6-pf52-xh8x** (cookie 0.6.0 out-of-bounds characters, low — via
  `@sveltejs/kit`, which still pins `^0.6.0`).

### Deferred from the 2026-09-05 review (items not in FIX-18's scope)

Tracked here so the next batch starts from a list, not another review:

- **#7 A settings-table read failure 500s every public page** — the
  request-scoped settings loader has no fallback; a transient DB error on
  the one query takes the public layout down.
- **#9 Content import can publish an unrenderable quiz** — the CLI import
  path bypasses the admin publish gate's render check.
- **#10 `checkout.session.expired` is unhandled** — stuck `pending` orders
  hold stock invisibly; no expiry sweep.
- **#12 Neon pool of one connection versus Vercel Fluid Compute** —
  concurrent invocations in one instance serialize on one WebSocket.
- **#13 Nightly backup trusts the runner's ambient `pg_dump`; retention can
  erase every good dump** — version pin and a "keep last good" rule.
- **#14 e-Factura drain has no submit-then-persist idempotency contract**
  (latent while the submitter is the no-op).
- **#15 `invoices.issued_at` has no index although the export comment
  claims one** — goes through `concurrent-indexes.ts`.
- **#16 CI gate does not run everything it claims, and a red e2e is
  invisible** — e2e is `continue-on-error` with no summary.
- **#17 E2E coverage gaps the audit listed remain open.**
- **#18 Untriaged low findings from the phase reviews that are real
  defects** (bundle) — see the review's item 18 list.
- **#19 CSP lacks `default-src`; consent cookie unversioned and never
  `Secure`.**
- **#20 STATE.md and CHANGELOG do not record the end state** — addressed
  in part by this section; the verification block below is real output.

Deferred / disagreed on the assigned items: nothing.

## Verification (FIX-18)

- `pnpm lint && pnpm check && pnpm test:unit`: green — web 132 files, 1275
  tests passed, 4 skipped (the pre-existing `skipIf(!PROXY)` driver-parity
  suite); formcomp 4 files, 27 tests. `svelte-check`: 3612 files, 0 errors.
- `pnpm audit --prod --audit-level=high`: exit 0 — "4 vulnerabilities found:
  1 low | 1 moderate | 2 high (2 ignored)"; the ignored pair and the two
  below-level ones are the "Accepted advisories" above.
- Builds after the dependency bumps: adapter-node and `DEPLOY_TARGET=vercel
  DB_DRIVER=neon` both green (SvelteKit 2.70.3 prints the
  `kit.csrf.checkOrigin` deprecation warning only).
- Both sites boot from the adapter-node build (`SITE_ID=sleep` on :4311,
  `SITE_ID=life` on :4312 against `better_life`): home 200, `/api/health`
  200 with the site id and the commit; processes stopped afterwards.
- Every test-first pair is visible in `git log` (7 `test(…)` commits each
  followed by its `fix(…)`/`docs(…)`); the failing tests reference
  `autoMigratedVatSchedule`, `vatScheduleAutoMigrated`, the `EMAIL_DRYRUN`
  problem line, the `Idempotency-Key` header, the CI audit step,
  `util/iban.ts` / `settings-save`, the checklist assertions and the
  `?f=invoice-missing` listing — all absent from their parent commits.
- Not run (no deliverable asks for it): `pnpm test:e2e`, `pnpm db:migrate`
  (no schema change).
- Fix round 1: the runner's gate failed only in `migrate-script.spec.ts`'s
  `afterAll` ("Hook timed out in 10000ms") — the scratch-database `DROP
  DATABASE` forces an immediate checkpoint that queues behind the in-progress
  spread checkpoint, whose sync phase took 20–30 s on the compose volume
  (`docker compose logs db | grep checkpoint`). Both hooks now carry a 120 s
  budget (commit `test(db): migrate-script spec hooks …`); assertions
  unchanged. Gate re-run green after the change.
