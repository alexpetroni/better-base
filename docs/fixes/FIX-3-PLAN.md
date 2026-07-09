# FIX-3 — Timeouts, pool limits, stream abort (Theme C)

Audit ref: Theme C (resilience #2/#3/#4, HIGH). See `docs/AUDIT-2026-07-09.md`.

## Problem

Silent hangs instead of graceful failure: the pg pool has no bounds
(`db/client.ts:9`), no outbound call has a timeout (Resend `email/resend.ts:14`, Anthropic
`chat/anthropic-provider.ts:14,18`, Stripe `shop/stripe-gateway.ts:10`), and the chat SSE
never aborts the upstream stream on client disconnect (`api/chat/+server.ts:63-79`, no
`cancel()`).

## Deliverables

1. Configure the pg pool: `max` (sensible for the deployment, e.g. 10–20),
   `connectionTimeoutMillis` (~5s, shed load instead of waiting forever),
   `idleTimeoutMillis`, and a server-side `statement_timeout` (via pool `options` or a
   per-connection `SET`). Values come from env with documented defaults in `.env.example`.
2. Add timeouts to every outbound call: `signal: AbortSignal.timeout(ms)` on the Resend
   fetch; `timeout` + bounded `maxRetries` on the Stripe client; `timeout`/`maxRetries`
   (or an AbortSignal) on the Anthropic client. Failures must surface as handled errors,
   not hangs.
3. Chat SSE: create the Anthropic stream with an `AbortController`; implement the
   `ReadableStream`'s `cancel()` to abort it (and stop the DB writes) when the client
   disconnects. Ensure `controller.close()` isn't called on an already-cancelled
   controller.

## Tests

- Unit/integration: Resend wrapper rejects (handled) when the fetch exceeds the timeout
  (inject a fake fetch that never resolves + a short timeout) — must fail before (hangs).
- Unit: chat SSE `cancel()` aborts the provider stream — use a mock provider whose stream
  observes the abort signal and assert it stops early and the assistant-message DB write
  does not run after cancel.
- Confirm pool options are applied (assert the client is constructed with the configured
  limits) and that a bad/unreachable DB now fails within the connection timeout rather
  than hanging (can be asserted against a closed port with a short timeout).

## Definition of Done

- [ ] Gate green; timeout/abort regression tests pass and failed (hung) before.
- [ ] Pool bounded; every outbound call has a timeout; SSE aborts upstream on disconnect.
- [ ] New env vars documented in `.env.example` with defaults.
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
