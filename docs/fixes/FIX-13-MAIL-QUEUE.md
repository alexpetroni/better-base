# FIX-13 — Mail and queue: idempotency semantics, unsubscribe, Resend, nurture

Audit refs: P1 "Email, CRM & nurture" (all four); P2 nurture queue frozen at enrollment.
See `docs/AUDIT-2026-09-03.md`.

## Problem

`email_log` treats `dryrun` and `sending` rows as final forever (`email/service.ts:65-67,
123-129`): the documented dry-run soak burns every confirm/nurture idempotency key of that
window, and a serverless kill between claim and transport leaves a row stuck that the
nurture drain then counts as sent. Unsubscribe is a GET side effect that mail scanners
trigger, with no `List-Unsubscribe` headers. Withdrawal keeps `confirmedAt`, so anyone
can re-opt-in a withdrawn address without double opt-in, and the "already subscribed"
response is a confirmed-status oracle. Resend errors are unclassified and unpaced, bounces
never fed back. The nurture queue is frozen at enrollment: pause→resume floods overdue
steps in unspecified order, config reseeds shift content under pending rows, parked sends
close the enrollment with no retry.

## Deliverables

1. **Email-log semantics.** `sending` rows older than a staleness window (10 min,
   constant) are reclaimable in both `shouldSkipResend` and the reclaim `UPDATE`;
   `dryrun` rows are reclaimable when the sender runs with `dryRun === false` (a dry-run
   record is not a delivery); the drain counts `skipped` as success only when the log row is
   `sent` (or `dryrun` while in dry run). `export const config = { maxDuration: 60 }` on
   the three cron routes and the Stripe webhook.
2. **Unsubscribe.** GET renders a confirmation page with a POST form (`?/unsubscribe`)
   that performs the revocation; an RFC 8058 one-click handler (`POST` with
   `List-Unsubscribe=One-Click`) at the same URL; `EmailMessage` gains optional `headers`
   and every marketing template sends `List-Unsubscribe` + `List-Unsubscribe-Post` through
   Resend. Same pattern for the DOI confirm link (GET shows a button; POST confirms) — or a
   documented reason to keep GET confirm.
3. **Consent integrity.** `unsubscribeByToken` clears `confirmedAt` (or the confirm check
   compares `confirmedAt` against the newest grant), so a re-grant after withdrawal sends a
   fresh DOI email; the newsletter action returns one "check your inbox" outcome for both
   new and existing addresses. Consent records gain `ip`, `userAgent` and
   `consentTextVersion` (the copy key/version the visitor saw).
4. **Resend transport.** Classify: 429/5xx/network → retryable; other 4xx → park
   immediately with the body; ~500 ms pacing inside a drain batch; a Resend webhook route
   (`/api/webhooks/resend`, signature-verified per Resend's svix scheme, mocked in tests)
   for `email.bounced` / `email.complained` that revokes consents and cancels nurture.
5. **Nurture queue.** In the claim, sends more than a grace window late (constant,
   e.g. 48 h) are cancelled with reason `stale` instead of sent; claimed rows are sent in
   `(enrollmentId, stepIndex)` order; a steps hash is stamped on send rows and a reseed
   cancels pending rows whose hash no longer matches (re-planned from the enrollment);
   an admin "retry" action (`failed → pending`, attempts reset); an enrollment with a
   `failed` send stays `active` (or gets a distinct `attention` status) instead of
   `completed`. DEPLOYMENT §12 notes the Vercel plan requirement for sub-daily crons.

## Tests

- **Integration (must FAIL on current code):** send under dry-run, flip to live, send the
  same key → the live send goes out; a `sending` row older than the window is re-sent
  exactly once under two concurrent callers; a fresh `sending` row is not.
- Integration: the nurture drain reports `sent` only for rows the log shows as sent.
- Integration: GET on the unsubscribe URL changes nothing; POST revokes; one-click POST
  revokes; template headers present in the dry-run record.
- Integration: withdraw then re-submit the form → a new confirm email, `isMailable` false
  until confirmed; the form response is identical for new/existing addresses.
- Unit: transport classification matrix; pacing; webhook signature verification.
- Integration: pause a sequence, advance the clock past the grace window, resume → stale
  steps cancelled, none sent out of order; reseed with a changed step → mismatched pending
  rows cancelled; retry action re-queues a parked send.

## Definition of Done

- [ ] Gate green; the dry-run→live and stale-claim regressions pass, each added in a test-first commit that precedes its fix in `git log`.
- [ ] `pnpm db:migrate` clean on fresh and populated DBs (consent fields, steps hash).
- [ ] DEPLOYMENT/LAUNCH-CHECKLIST: Resend webhook wiring, headers, plan note.
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
