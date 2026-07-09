# FIX-1 — Atomic rate limiting + throttle public email endpoints (Themes A & F)

Audit refs: Theme A (security H1, resilience #5), Theme F (security H2). See
`docs/AUDIT-2026-07-09.md`.

## Problem

All counters do non-atomic read→compute-in-JS→write-absolute-value, so concurrent
requests lose increments and bypass caps (login limiter `auth/rate-limit.ts:36-43` +
`admin/login/+page.server.ts:30-46`; chat limiter `chat/service.ts:102-110` +
`chat/rate-limit.ts:57-64`). Both are also fixed-window (boundary burst). Separately, the
public newsletter (`newsletter/+page.server.ts:11-39`) and quiz-result email
(`quiz/[slug]/rezultat/[resultId]/+page.server.ts:22-37`) endpoints send to an
attacker-supplied address with NO throttling.

## Deliverables

1. A single shared rate-limit core (e.g. `src/lib/server/rate-limit/` or a shared module)
   with an **atomic** DB upsert: `INSERT … ON CONFLICT DO UPDATE SET count =
   table.count + 1` with window reset handled in SQL, returning the post-increment count;
   the cap decision is made from the returned value (no separate read). Prefer a sliding
   or at least correctly-reset fixed window that closes the boundary-burst gap.
2. Reimplement the login limiter and chat limiter on top of this core (keep their separate
   tables; delete the duplicated fixed-window logic — this also resolves simplification #4).
3. Add per-IP + global throttling to the newsletter and quiz-result email actions using
   the shared limiter (sensible RO-facing 429/error message). A lightweight
   proof-of-work or CAPTCHA hook point is acceptable if wired but disabled by default;
   document it. At minimum the IP + global caps must exist and be enforced server-side.
4. Migration for any new/changed rate-limit table columns if needed.

## Tests

- Unit: the atomic core — window reset, boundary behavior, cap enforcement from the
  returned count.
- **Integration (concurrency, real test DB): fire N parallel login attempts for one email
  and assert the counter reaches exactly N (no lost increments) and the cap blocks at the
  limit** — this test must FAIL against the current non-atomic code. Same racing test for
  the chat limiter.
- Integration: newsletter/quiz-result actions return 429 after the IP cap; distinct
  victims can't be mailbombed (global cap trips).

## Definition of Done

- [ ] Gate green; the concurrency regression tests pass and demonstrably failed before.
- [ ] Login, chat, newsletter, and quiz-result endpoints all enforce limits atomically.
- [ ] Duplicated fixed-window code removed; both limiters use the shared core.
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
