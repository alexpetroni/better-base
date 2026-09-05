# modules/nurture — scheduled drip email on the cron seam

Nurture sequences: after a subscriber confirms a marketing consent, completes a
quiz, or places an order, a small series of scheduled emails goes out. This
module owns the sequence data model, enrollment, scheduling, and the queue
drain; sending itself goes through `modules/email` like every other email.

## Design decision: a database-backed queue drained by cron

**Decision.** Due sends are rows in Postgres (`nurture_sends`, one row per
enrollment step, with a `scheduled_at` timestamp), and the existing guarded
cron seam (`/api/cron/nurture-send`, `authorizeCron`, `CRON_SECRET`) drains a
bounded batch per invocation. There is no worker process and no external
scheduler.

**Why this over the alternatives.**

- _A long-lived worker / in-process timer_ is impossible on Vercel (no
  long-lived process) and would make the two deployment targets behave
  differently — the constitution requires identical behavior on adapter-node
  and Vercel. The cron seam already exists, is authenticated, and is proven by
  `chat-prune` and `shipment-sync`.
- _An external scheduler / email-automation SaaS_ would add a provider account,
  credentials and a webhook surface for a launch that does not need one — and
  it could not check consents transactionally: the GDPR-critical property
  ("a withdrawn consent stops every pending send immediately") is a single
  `UPDATE` when the queue lives next to the `subscribers` table, and a
  best-effort remote sync when it does not.
- _Postgres is already the source of truth_ for subscribers, consents and the
  email log. A `SELECT … FOR UPDATE SKIP LOCKED` claim gives exactly-once
  dispatch under concurrent cron invocations with zero new infrastructure, and
  the `email_log` unique idempotency key (`nurture:<enrollmentId>:<stepIndex>`)
  is a second, independent layer under it.

**Maximum drift between scheduled time and send.** A send becomes eligible at
`scheduled_at` and is picked up by the next cron invocation, so the drift is at
most one cron interval (15 minutes as registered in `vercel.json`) plus, when a
backlog exceeds the per-invocation bound, one extra interval per
`NURTURE_SEND_BATCH` older sends ahead of it. Nurture steps are day-granular
(`offsetDays`, optional local send hour), so minutes of drift are irrelevant by
design — anything needing second-level precision does not belong in this queue.

**Per-invocation bound.** `NURTURE_SEND_BATCH = 25` sends per invocation
(`schedule.ts`), mirroring `SHIPMENT_SYNC_BATCH`: small enough to finish well
inside a serverless time limit with one email-API round trip per send, large
enough that a full batch is cleared in one interval for any realistic list at
launch scale. A larger backlog simply drains over consecutive runs, oldest
`scheduled_at` first.

## Data model

- `nurture_sequences` — one row per sequence: unique `key`, `trigger` (jsonb),
  `consent_key` (which marketing consent gates it), ordered `steps` (jsonb:
  offset from enrollment, template key, subject/copy), `active` flag. Sequences
  are **data**: better-life seeds different rows from `config/sites/life.ts`
  and the operator can deactivate a sequence in `/admin/nurture` without a
  deploy. Seeding (`seedNurtureSequences`) upserts by `key` but deliberately
  never touches `active` — the operator's kill switch survives a reseed.
- `nurture_enrollments` — one subscriber in one sequence,
  `UNIQUE (sequence_id, subscriber_id)`: **a subscriber enrolls in a sequence
  at most once, ever**. Re-triggering (retaking a quiz, re-confirming, a second
  order) is a no-op — that is the re-enrollment rule, enforced by the unique
  index, not by handler logic. `ON DELETE CASCADE` from `subscribers`: GDPR
  erasure removes enrollments and sends with the subscriber row.
- `nurture_sends` — the queue. One row per (enrollment, step), materialized at
  enrollment time with a computed `scheduled_at` and the `steps_hash` of the
  sequence's steps it was planned against. Statuses:
  `pending → sending → sent`, with `failed` (parked for the operator after
  `NURTURE_MAX_ATTEMPTS`, or immediately on a permanent transport error —
  the enrollment stays `active` until the operator's **retry** in
  `/admin/nurture` re-queues it), and `cancelled` with `last_error` naming
  why: consent withdrawn / unsubscribe / bounce / complaint (null), `stale`
  (more than `NURTURE_STALE_SEND_HOURS` late when it became claimable — a
  resumed pause never floods the missed steps), `replanned` (its step vanished
  in a reseed).

## Re-planning (FIX-13)

The queue is not frozen at enrollment. Inside the claim, rows more than
`NURTURE_STALE_SEND_HOURS` (48 h) past `scheduled_at` are cancelled as `stale`
instead of sent; the claimed batch is then sent grouped by enrollment in step
order, so a backlog never delivers step 2 before step 1. A reseed
(`seedNurtureSequences`, `db:seed`) whose steps changed re-plans every pending
row of an active enrollment whose `steps_hash` no longer matches: the row is
re-scheduled from the enrollment instant with the new step at its index
(attempts reset), cancelled as `replanned` when the step no longer exists, and
new trailing steps get fresh rows. Delivered/in-flight/parked rows are history
and untouched; rows with a NULL hash (planned before the column) are left
alone.

## Consent (the GDPR-critical property)

Enrollment has exactly one gate, `isMailable`: the sequence's `consent_key`
consent is granted **and** the address is double-opt-in confirmed
(`confirmed_at`). Every trigger path goes through it — a subscriber who never
granted the relevant marketing consent is never enrolled. The drain re-checks
the same gate immediately before each send (defense in depth), and an
unsubscribe / consent withdrawal cancels all pending sends across sequences via
`cancelSubscriberNurture`. Every nurture email carries the subscriber's
non-expiring unsubscribe link.

## Scheduling

`computeStepScheduledAt` (pure, `schedule.ts`): `offsetDays` after the
enrollment instant; with `hourLocal` set, at that wall-clock hour in
`Europe/Bucharest` on the target calendar day — computed via `Intl` timezone
parts (two-pass offset resolution), so DST transitions shift the UTC instant
instead of the subscriber-visible hour. A computed time not after the
enrollment instant clamps to it (an `offsetDays: 0` step with an already-past
`hourLocal` sends on the next drain rather than in the past).

## Failure handling

The claim increments `attempts`. A retryable failure (Resend 429/5xx, network,
timeout — `EmailTransportError.retryable`) goes back to `pending` with
`scheduled_at = claim time + 15min × 4^(attempts−1)` (15m, 1h, 4h, 16h); after
`NURTURE_MAX_ATTEMPTS = 5` it is parked as `failed` with the error recorded and
shown in `/admin/nurture` — never an infinite loop. A permanent failure (any
other 4xx: bad key, rejected address) parks immediately with Resend's body.
Live sends inside a batch are paced by `NURTURE_SEND_PACE_MS` (500 ms; Resend
allows ~2 req/s); dry runs are not. A crashed invocation leaves rows in
`sending`; the claim re-takes those after `NURTURE_STALE_CLAIM_MINUTES`, and
the `email_log` idempotency key guarantees the retry cannot double-deliver —
a `skipped` outcome counts as sent only when the log row itself reads `sent`
(or `dryrun` while the sender runs dry). Bounces and complaints reported by
Resend's webhook (`/api/webhooks/resend`) withdraw the address and cancel its
enrollments like an unsubscribe.

## Retention

Closed (completed or cancelled) enrollments and their send rows are deleted by
the shared retention sweep `NURTURE_RETENTION_DAYS = 180` days after closing —
long enough to answer "why did/didn't I get this email" support questions; the
durable proof of what was actually sent is `email_log`.
