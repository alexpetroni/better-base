# FIX-18 — Final review follow-ups: the high findings, the launch checklist, the dropped FIX-10 item

Source: the whole-project adversarial review of 2026-09-05 at `91acdd3`
(`.phase-runner/state/REVIEW.md`, items 2–6, 8 and 11). Item 1 of that review (the five
medium phase-review findings) was closed by FIX-17. This phase takes every finding the
review rated **high**, the launch-checklist defect that would block the first production
deploy, and the FIX-10 medium finding that was never triaged. The remaining medium and
low items (7, 9, 10, 12–20) are explicitly out of scope; record them as deferred in
`docs/STATE.md` so the next batch starts from a list, not from another review.

## Problem

Seven production defects survive the batch: an upgrade of a pre-August-2025 installation
freezes a stale 19 % VAT rate forever; `launch:check` blesses a production deploy that
sends no email; a Resend transport timeout retries into a duplicate customer email; the
sanitizer, image probe and framework carry published advisories, one guarding every raw
HTML sink; settings saves (including the invoice IBAN) leave no audit trail and the IBAN
is unvalidated; the launch checklist tells the operator to set a secret CI never reads and
to run a workflow that no longer exists; and a shipped, partially refunded order never
surfaces in the "invoice missing" queue for the storno it owes.

## Deliverables

1. **Stale standard VAT rate after migration 0024.**
   `apps/web/drizzle/0024_vat_model.sql:15-28` writes `'2025-08-01 <old rate>'` into
   `invoice.vatStandardRates` from the pre-FIX-12 `invoice.vatRateBp`, and
   `util/vat-rates.ts:94-101` resolves every later order through that entry. An
   installation live before 2025-08-01 whose operator never edited the rate stores `1900`;
   after upgrade every invoice is issued at 19 % instead of 21 % indefinitely. The
   migration is immutable, so: detect the auto-migrated shape (single line, dated
   `2025-08-01`, value equal to the legacy rate, never re-saved) and (a) `launch:check`
   reports it as a problem outside `--dev`, (b) the admin settings page shows a warning on
   that field, (c) DEPLOYMENT and RUNBOOK document the upgrade step ("open Settings →
   Invoice, confirm the standard-rate schedule, save"). A tracked "re-saved" marker (a
   settings key or a `savedAt` on the schedule) is acceptable; do not rewrite the migration.

2. **`launch:check` refuses a production deploy with `EMAIL_DRYRUN=true`.**
   `apps/web/src/lib/server/launch-check.ts:86-160` only reacts when the flag is `false`;
   `launch-check.spec.ts:14-38` combines a live Stripe key and a real domain with dry-run
   email and asserts zero problems. Add a production-only rule mirroring the mock-provider
   pattern at `launch-check.ts:144-157`, gated behind `--allow-mock-providers`. Update the
   spec fixture: the unmodified production fixture must now report a problem, and the
   fixture with `--allow-mock-providers` stays clean.

3. **Resend `Idempotency-Key`.**
   `email/resend.ts:46-71` sets no idempotency header and `email/service.ts:90-99` treats
   every `error` row as retryable, so a 10 s timeout after Resend already accepted the
   message becomes a retryable error and the next drain tick delivers a second order
   confirmation, invoice, shipping notice or nurture step (`email.spec.ts:484-496`
   documents the hung-socket path as intended). Carry the local idempotency key on
   `EmailMessage` and send it as the `Idempotency-Key` header on every Resend call; keep
   the key stable across retries of the same `email_log` row. Correct
   `nurture/README.md:122-124` so it no longer overstates the guarantee.

4. **Vulnerable production dependencies.**
   Installed `sanitize-html@2.17.5` (patched ≥ 2.17.7; GHSA-g8qq-57p8-ggw5,
   GHSA-jxwj-j7wr-gfrw; config at `blog/markdown.ts:63-107`, guards all five `{@html}`
   sinks), `image-size@2.0.2` (patched ≥ 2.0.3; fed raw upload bytes at
   `media/service.ts:112`), `@sveltejs/kit@2.69.1` (patched ≥ 2.70.2), plus transitive
   `nanoid`, `postcss`, `esbuild`, `cookie`. Bump the three direct dependencies to the
   patched versions, `pnpm dedupe`, add the advisory payloads as vectors to the markdown
   XSS spec, and add `pnpm audit --prod --audit-level=high` to the gate script and to the
   CI `gate` job. If a remaining transitive advisory has no upstream fix, record it with
   its id and reason in `docs/STATE.md` rather than lowering the audit level.

5. **Settings audit row and IBAN validation.**
   `apps/web/src/routes/admin/(shell)/settings/+page.server.ts:52-81` saves with no audit
   record (`modules/auth/audit.ts:11-17` has no `settings-save` action), and
   `settings/registry.ts:191` has no checksum on `company.iban` although the value is
   printed on every invoice, PDF and e-Factura `PayeeFinancialAccount`. Add `settings-save`
   to the audit action union and record actor, group and the changed keys, with old → new
   values for `company.iban` and `company.bank`. Add an `ibanMod97` helper next to
   `util/cui.ts` (ISO 13616: move the first four characters to the end, convert letters to
   numbers, mod 97 must equal 1; accept spaces, normalise to upper case) and wire it as the
   field's `validate`.

6. **Launch checklist matches the shipped pipeline.**
   `LAUNCH-CHECKLIST.md:230-233` says set `DIRECT_DATABASE_URL` and run "Actions →
   migrate"; the secret is `DIRECT_DATABASE_URL_SLEEP` (`deploy/sites.json:5`) and only
   `ci.yml` has `workflow_dispatch`. An operator following the box sets a secret CI never
   reads and the fail-closed guard at `ci.yml:242-247` blocks the first production deploy
   with no explanation. Rewrite the box against `deploy/sites.json` and `ci.yml`, and add
   a doc test asserting the checklist never mentions `migrate.yml` or an unsuffixed
   `DIRECT_DATABASE_URL`.

7. **Shipped, partially refunded orders surface for the owed storno.**
   The `invoice-missing` predicate in `shop/webhook.ts` (~`:991-1001`) ignores
   `refunded_cents > Σ stornos`, so a shipped order with a partial refund and no storno
   never appears in the `?f=invoice-missing` queue (FIX-10's medium finding, never
   triaged). Extend the shared predicate so an order whose refunded total exceeds the sum
   of its issued stornos counts as invoice-missing; use the same predicate wherever the
   queue or its badge is computed.

8. **Deferred list.** Add a "Deferred from the 2026-09-05 review" section to
   `docs/STATE.md` listing review items 7, 9, 10 and 12–20 by title with one line each, so
   they are tracked without being silently dropped.

Keep each deliverable to its own commit pair (failing test, then fix). No refactors
beyond what the fix needs; no changes to unrelated modules.

## Tests

Every test below must FAIL on the current code before its fix commit.

- Unit, launch-check: the auto-migrated single-line VAT schedule reports a problem outside
  `--dev` and is silent after an operator save; the unmodified production fixture reports
  `EMAIL_DRYRUN` as a problem; the same fixture with `--allow-mock-providers` is clean.
- Unit, vat-rates or settings: the "auto-migrated shape" detector is true for
  `[{ from: '2025-08-01', bp: 1900 }]` with no re-save marker and false once re-saved or
  edited.
- Unit, email: two sends of the same `email_log` row across a simulated timeout carry the
  same `Idempotency-Key` header on both fetch calls; distinct messages carry distinct keys.
- Unit, markdown: the sanitize-html advisory payloads (allowlist and mXSS bypass vectors
  from the two advisories) are neutralised by the blog sanitizer config.
- Gate script: `pnpm audit --prod --audit-level=high` exits 0; `migrate-workflow.spec.ts`
  asserts the audit step exists in the `gate` job.
- Unit, audit: one `settings-save` row per successful save with actor, group and changed
  keys; `company.iban` old → new recorded; a save with no changed keys writes no row.
- Unit, iban: `RO49AAAA1B31007593840000` validates, a transposed-digit variant is refused,
  lower case and inner spaces are normalised; the settings registry refuses an invalid
  IBAN with a field error.
- Doc test: `LAUNCH-CHECKLIST.md` contains neither `migrate.yml` nor an unsuffixed
  `DIRECT_DATABASE_URL`; every secret it names appears in `deploy/sites.json` or `ci.yml`.
- Unit, orders page (`orders-page.spec.ts`): a shipped order with `refunded_cents > 0` and
  no storno appears under `?f=invoice-missing`; the same order with a storno covering the
  refund does not.

## Definition of Done

- [ ] Deliverables 1–7 implemented, each as a failing-test commit followed by its fix
      commit; the failing test references a symbol or behaviour absent from its parent.
- [ ] Gate green (`pnpm lint && pnpm check && pnpm test:unit`); `pnpm audit --prod
      --audit-level=high` clean or every remaining advisory recorded in STATE.md with its
      id and reason; no existing test weakened, skipped or deleted.
- [ ] `DEPLOY_TARGET=vercel pnpm build` and the adapter-node build both succeed after the
      dependency bumps; both `SITE_ID`s boot.
- [ ] `ci.yml` gate job runs the audit step; `migrate-workflow.spec.ts` asserts it.
- [ ] DEPLOYMENT and RUNBOOK document the VAT-schedule upgrade step; LAUNCH-CHECKLIST
      matches `deploy/sites.json` and `ci.yml`; `nurture/README.md` states the real email
      delivery guarantee.
- [ ] `docs/STATE.md` carries the deferred list (deliverable 8) and a FIX-18 entry;
      `docs/CHANGELOG.md` gets a dated FIX-18 entry; work committed.
