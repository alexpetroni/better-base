# FIX-6 — Fail-fast boot, health status, security hardening

Audit refs: resilience #9, #10; security H3, M1, M2, L1–L7. See
`docs/AUDIT-2026-07-09.md`.

## Problem

Only the chat provider validates env at boot; other required env resolves lazily so the
app boots "healthy" then 500s on first use, and `/api/health` throws 500 (not 503) when
env is missing. Several security hardening gaps: committed default imgproxy key/salt with
`:-<default>` fallbacks (forgeable signing if inherited), SVG served verbatim,
`getClientAddress` trust behind a proxy, one shared secret for auth+consent+chat tokens.

## Deliverables

1. **Fail-fast env validation at startup**: validate all required env once at boot
   (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `S3_*`, `IMGPROXY_*`, and `RESEND_API_KEY` when
   `EMAIL_DRYRUN=false`) using the existing boot-check pattern — the app should refuse to
   start with a clear message rather than 500 later.
2. **Health endpoint**: wrap dependency construction so missing env / unreachable
   dependencies return **503** with a structured body (not a 500 with a stack); keep the
   bounded `Promise.race` timeouts.
3. **imgproxy secret hygiene**: remove the `:-<default>` fallbacks in `docker-compose.yml`
   and `.env.example` so a missing key/salt fails fast; `.env.example` carries
   placeholders only, with a comment to generate real values. Document rotation.
4. **Dedicated `TOKEN_SECRET`**: stop reusing `BETTER_AUTH_SECRET` for CRM consent tokens
   (`crm/server.ts`) and chat session tokens (`chat/server.ts`); introduce `TOKEN_SECRET`
   (documented, with a safe local default distinct from the auth secret).
5. **SVG uploads**: drop `image/svg+xml` from the allowlist OR enable
   `IMGPROXY_SANITIZE_SVG=true` and serve with `Content-Disposition: attachment` +
   restrictive headers. Pick one and document it.
6. **Proxy/IP trust (M2)**: document (and where applicable configure) the correct
   `ADDRESS_HEADER` + hop depth for the intended deployment so IP-based limits work and
   `X-Forwarded-For` isn't blindly trusted. Note it in DEPLOYMENT.md.
7. Address the cheap L-items where low-risk: enforce an explicit small body-size limit
   before parsing chat/quiz bodies (L1); redact tokens from logged URL paths (L2); bind
   media `confirm` to the presign via a signed ticket (L3) if not too invasive; optionally
   add a `processed_events(event_id)` guard for Stripe (L6). Do the ones that are clearly
   worth it; note any deliberately deferred.

## Tests

- Integration/unit: boot validation throws with a clear message when a required env var is
  missing (parameterize a couple); with `EMAIL_DRYRUN=false` and no key it fails at boot,
  not at first send.
- Integration: `/api/health` returns 503 (not 500) when a dependency is unavailable.
- Unit: consent/chat tokens signed with `TOKEN_SECRET` verify, and do not verify under
  `BETTER_AUTH_SECRET` (proves separation).
- Unit: SVG upload is rejected (if dropped) or sanitized path is taken.
- Unit: oversized chat/quiz body rejected before full parse.

## Definition of Done

- [ ] Gate green; fail-fast + health-503 + token-separation tests pass.
- [ ] No committed usable imgproxy key fallback; SVG handled; body limits enforced.
- [ ] DEPLOYMENT.md updated (env matrix, proxy header, secret rotation, TOKEN_SECRET).
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
