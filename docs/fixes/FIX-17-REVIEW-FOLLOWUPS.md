# FIX-17 — Follow-ups from the FIX-12…16 phase reviews (medium findings)

Source: the independent reviewer's verdicts for FIX-12 through FIX-16
(`.phase-runner/state/reviews/FIX-1{2,3,4,5,6}-*.md`, 2026-09-05). Each phase passed;
these are the five findings rated **medium** — real defects, none blocking at the time,
all cheap to close. Nothing else from those verdicts is in scope here.

## Problem

Five small correctness gaps survived the remediation batch: a parked e-Factura submission
has no way back into the queue while the statutory clock runs; a nurture sequence that is
shrunk and then grown again silently never sends the re-added step; the chat provider's
inactivity timer fires before the first byte and defeats the configured retry; the media
upload confirm trusts any key it is handed and can delete a served object; and the request
id adopts a client-supplied `x-vercel-id` on adapter-node, letting a caller choose the
correlation key the logs and error page show.

## Deliverables

1. **Re-queue parked e-Factura submissions.**
   `apps/web/src/lib/modules/invoice/submissions.ts:158` — a row parked as `failed` after
   `EFACTURA_MAX_ATTEMPTS` is never claimed again and no admin action or script resets it,
   while the 5-day statutory clock keeps running; a transient render/storage failure
   (fiscal bucket missing in prod) parks a document within ~8 hours and the only recovery
   is manual SQL. Add `requeueParkedSubmission({ db }, invoiceId)` (and an "all parked"
   variant) in the submissions module: `UPDATE … SET status='pending', attempts=0,
   next_attempt_at=NULL, last_error=NULL WHERE status='failed'`, returning whether a row
   changed. Expose it as an admin-only `requeue` form action on the order page (or the
   `/admin/orders` "De trimis la ANAF" list) following the pattern of the nurture `retry`
   action, declare it in the authz route manifest, and add a `pnpm efactura:requeue
   [--all | <invoiceId>]` script for the operator. Document the path in DEPLOYMENT §7 and
   RUNBOOK.

2. **Nurture replan reopens cancelled steps.**
   `apps/web/src/lib/modules/nurture/service.ts:406` — `replanSequenceSends` builds the
   `known` step-index set from every row of the enrollment regardless of status. A reseed
   that shrinks the steps cancels the trailing row (`lastError = 'replanned'`); a later
   reseed that grows them again finds the index already known, inserts nothing (the unique
   index on `(enrollment_id, step_index)` forbids a second row anyway) and that step is
   silently never sent. Exclude rows with `status='cancelled' AND lastError='replanned'`
   from `known`; for those indexes UPDATE the existing row back to `pending` with the new
   `scheduledAt`, `stepsHash`, `attempts: 0`, `lastError: null` instead of inserting.

3. **Chat inactivity timer armed after the first event.**
   `apps/web/src/lib/modules/chat/anthropic-provider.ts:73` — the 15 s inactivity timer is
   armed before `client.messages.stream()` is called and its AbortSignal is merged into the
   request signal; the SDK checks `signal.aborted` before every attempt and retry, so an
   attempt whose headers take longer than 15 s is aborted before the 20 s `timeout` and
   `maxRetries: 1` can never retry. Effective time-to-first-byte budget is 15 s with no
   retry, contradicting `chat/README.md:34` ("2 × 20 s = 40 s to first byte"). Arm the
   inactivity timer only once the stream has emitted its first event (or arm a first timer
   of `timeoutMs × (maxRetries + 1) + slack` and switch to `inactivityMs` after the first
   event); correct the README rows to describe the real budget.

4. **Upload confirm only accepts pending keys.**
   `apps/web/src/lib/modules/media/service.ts:100` — `confirmUpload` never asserts that
   `input.key` is under `PENDING_PREFIX`; it copies whatever key it is given into a new
   `uploads/` key and then deletes the original. Today the signed ticket binds the key, but
   a ticket minted before this deploy for an `uploads/…` key, or any future caller, would
   delete a served object an existing media row points at. At the top of `confirmUpload`:
   `if (!input.key.startsWith(PENDING_PREFIX)) return { ok: false, error: 'not-found',
   detail: 'not a pending upload' }`.

5. **Request id adopts `x-vercel-id` only on Vercel.**
   `apps/web/src/lib/server/request-id.ts:22` — `resolveRequestId` adopts a
   request-supplied `x-vercel-id` on every target; on adapter-node any client can send
   `x-vercel-id: <anything>` and choose the key that lands in the request log, the error
   log line and the error page — exactly what the function's own comment forbids for
   `x-request-id`. Take an `onVercel` flag (`env.VERCEL` truthy) and return the header only
   when it is set, otherwise always mint the UUID; validate the adopted id's charset and
   cap its length (Vercel ids are short `[A-Za-z0-9:-]` tokens). Thread the flag from
   `hooks.server.ts`.

Keep each deliverable to its own commit pair (failing test, then fix). No refactors
beyond what the fix needs; no changes to unrelated modules.

## Tests

Every test below must FAIL on the current code before its fix commit.

- Unit, submissions: a `failed` row with `attempts = EFACTURA_MAX_ATTEMPTS` is claimed and
  submitted by the next `submitPendingEFactura` tick after `requeueParkedSubmission`; a
  `pending`/`submitted` row is untouched (returns false). Route spec: the `requeue` action
  is admin-only and appears in the authz route manifest.
- Unit, nurture (`nurture.spec.ts`): reseed 3 → 2 steps, then 2 → 3, drain past the third
  step's time; expect the third step sent exactly once with the new `scheduledAt`.
- Unit, chat provider: a fake client whose first attempt yields no headers for
  `inactivityMs + 1` and succeeds on the retry produces a normal stream (no abort); a
  stream that emits one event and then nothing for `inactivityMs` is aborted with the
  error frame (existing behaviour, keep green).
- Unit, media: `confirmUpload` with an `uploads/…` key returns `not-found` and the storage
  fake records no copy and no delete.
- Unit, request id: `resolveRequestId(new Headers({ 'x-vercel-id': 'spoofed' }), rnd,
  { onVercel: false })` returns the UUID; with `onVercel: true` it returns `spoofed`; an
  over-long or non-token header value on Vercel falls back to the UUID.

## Definition of Done

- [ ] All five deliverables implemented, each as a failing-test commit followed by its fix
      commit; the failing test references a symbol or behaviour absent from its parent.
- [ ] Gate green (`pnpm lint && pnpm check && pnpm test:unit`); no existing test weakened,
      skipped or deleted.
- [ ] `requeue` action declared in the authz route manifest; `pnpm efactura:requeue`
      script wired in `apps/web/package.json`; DEPLOYMENT §7 and RUNBOOK describe the
      operator path.
- [ ] `chat/README.md` timing rows match the implemented budget.
- [ ] Both `SITE_ID`s boot; `docs/CHANGELOG.md` gets a dated FIX-17 entry; short
      `docs/STATE.md` updated; work committed.
