# FIX-14 — Chat: history parity, provider configuration, abuse bounds

Audit refs: P1 "Chat" (all three); P2 mock provider undetectable. See
`docs/AUDIT-2026-09-03.md`.

## Problem

`capHistory` slices the newest 20 rows without regard to role, so with alternating turns
the 11th message sends a window that starts with an assistant turn — rejected by the
Messages API; every conversation fails deterministically once, masked by the mock. The
Anthropic call omits `thinking` (adaptive thinking on `claude-sonnet-5` counts against the
1024-token cap), never reads `stop_reason`, swallows SDK errors without a log line, and
allows a 180 s SDK budget under a 60 s `maxDuration`. Cookieless POSTs insert session rows
before the limiter runs; the retention sweep deletes in one statement that can never
finish under `statement_timeout`; the full history is loaded per message. A mock provider
in production is undetectable.

## Deliverables

1. **History parity.** After capping, drop leading non-`user` messages; read history with
   `ORDER BY created_at DESC, id DESC LIMIT n` and reverse (as `getChatHistory` does).
2. **Provider configuration.** `thinking: { type: 'disabled' }` (or `output_config:
   { effort: 'low' }` — pick one, justify in the README) and a higher `max_tokens`
   sized for the persona; read the final message / `message_delta` and emit a distinct SSE
   frame (`{ stop: 'max_tokens' | 'refusal' }`) that the panel renders as a truncated or
   declined reply with retry; `console.error` caught SDK errors with class + status through
   `formatServerError`; `timeoutMs` ≈ 20 s and `maxRetries: 1`; a stream-inactivity
   timeout; the panel marks a bubble failed when the stream closes without `done`.
3. **Abuse bounds.** Consume the IP counter before `resolveSession`; create the session row
   only after both checks pass. Prune chat sessions and nurture enrollments in batches
   (`DELETE … WHERE id IN (SELECT … LIMIT 5000)` loops) with each pruner in its own
   try/catch and per-step counts in the sweep result.
4. **Observability.** One boot log line `chat provider: <kind>`; the kind in `/api/health`;
   a `launch:check` rule: `EMAIL_DRYRUN=false` with `CHAT_PROVIDER !== 'anthropic'` fails
   unless `--allow-mock-providers` is passed (same rule for `COURIER_PROVIDER`).

## Tests

- **Unit (must FAIL on current code):** 21 alternating rows → capped window starts with a
  `user` turn and has ≤ 20 entries.
- Unit: provider maps a `max_tokens` / `refusal` stop into the stop frame; an SDK error is
  logged and mapped to the error frame (fake fetch seam).
- Integration: a cookieless caller past the IP cap creates no session row.
- Integration: the sweep prunes 12 000 expired sessions in batches and completes; a
  failing pruner does not prevent the others from running.
- Unit: launch-check rule matrix for mock providers; health payload carries the kind.

## Definition of Done

- [ ] Gate green; the parity regression pass, each added in a test-first commit that precedes its fix in `git log`.
- [ ] Chat README documents the provider settings and why.
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
