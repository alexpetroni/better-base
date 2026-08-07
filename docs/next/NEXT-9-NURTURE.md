# NEXT-9 — Nurture sequences: scheduled email on the cron seam

Context: `docs/STATE.md` § "Known gaps" ("only transactional + double-opt-in emails exist;
no scheduled newsletter/drip sending (needs a queue/cron design decision)"). Depends on
NEXT-5 (idempotency patterns) and the cron seam.

## Problem

The CRM captures subscribers with double opt-in and per-purpose consents, and quiz results
are the main acquisition path — but nothing is ever sent afterwards. The blocker was
recorded as a design decision, not a coding problem: there is no queue, and on Vercel there
is no machine to run a worker on. Make the decision explicitly, in the direction the rest of
the architecture already went: **a database-backed queue drained by the existing cron
route**, bounded per invocation, idempotent, and identical on both deployment targets.

## Deliverables

1. **The design decision, written down first** (module README): why a DB queue + cron over
   an external scheduler, what the maximum drift is between the scheduled time and the send,
   and what the per-invocation bound is. Later phases should not have to re-derive it.
2. **Sequence definitions as data + config**, not code: a sequence has a trigger (subscriber
   confirmed a marketing consent; completed a quiz with a given result band; placed a first
   order), an ordered list of steps (offset from enrollment, email template key), and an
   active flag. better-life must be able to run different sequences from the same code.
3. **Enrollment + scheduling**: triggers enroll a subscriber once per sequence (re-enrolment
   rules defined and tested), materializing due sends with a scheduled-at timestamp. A
   subscriber who never granted the relevant marketing consent is never enrolled — assert
   it, this is the GDPR-critical property.
4. **Draining on cron**: a guarded cron route claims a bounded batch of due sends
   (claim-then-send, so two concurrent invocations cannot double-send — the claim must be
   atomic), sends through `modules/email` with an idempotency key derived from
   (enrollment, step), and records the outcome. Failures retry with backoff up to a cap,
   then park for operator attention rather than looping forever.
5. **Unsubscribe and consent withdrawal stop everything immediately**: withdrawing consent
   or unsubscribing cancels all pending sends for that subscriber, across sequences.
   Every nurture email carries a working unsubscribe link (the existing CRM one).
   Suppression list respected — a hard-bounced or unsubscribed address is never mailed.
6. **Admin visibility**: a minimal view of sequences (active, enrolled count, sends
   pending/sent/failed) and the ability to deactivate a sequence — an operator must be able
   to stop a bad sequence without a deploy. Reuse the settings/admin patterns; keep it
   small.
7. **Schedules registered** in `vercel.json` and documented for machine cron in
   `DEPLOYMENT.md` §9. Retention: completed enrollments and send records expire via
   `server/retention.ts`.

## Tests

- Unit: schedule computation — step offsets produce the right due timestamps, including
  DST-crossing dates in `Europe/Bucharest` (this is where naive date math breaks).
- Integration: enrollment happens once per trigger; re-trigger follows the defined rule.
- Integration: **no consent ⇒ no enrolment**, and consent withdrawal mid-sequence cancels
  every pending send.
- Integration: two concurrent cron invocations against the same due batch send each email
  exactly once (real parallel promises, not a comment).
- Integration: per-invocation bound respected; a large backlog drains over multiple runs.
- Integration: send failure retries with backoff and parks after the cap; parked sends are
  visible in admin.
- Integration: unsubscribe link in a nurture email works end-to-end and suppresses future
  sends.
- Integration: cron auth (401 no token / 401 wrong token / 200 right token / 503 with
  `CRON_SECRET` unset) for the new route, matching the existing prune route's contract.

## Definition of Done

- [ ] Gate green.
- [ ] A subscriber with consent receives step 1 then step 2 on schedule (time-travelled in
      the test), and a subscriber without consent receives nothing — both proven.
- [ ] Double-send is impossible under concurrency; withdrawal stops sends immediately.
- [ ] Sequences are data; better-life can differ without a code change.
- [ ] `vercel.json` + `DEPLOYMENT.md` §9 updated; retention covers the new tables.
- [ ] STATE.md updated; work committed.
