# FIX-9 — Authorization guard, security headers, admin role scoping

Audit refs: P0 #1; P1 "Auth, GDPR & frontend" (security headers/CSP, editors see customer
emails, login hardening, GDPR erase mixed-case emails). See `docs/AUDIT-2026-09-03.md`.

## Problem

The `/admin` guard in `src/hooks.server.ts:54-73` keys on `deLocalizeUrl(event.url).pathname`,
which is not percent-decoded, while SvelteKit decodes the path before matching routes. A
raw request to `/%61dmin/subscribers/export.csv` reaches the route with `locals.user = null`
and returns the whole subscriber table; encoded POSTs run admin form actions
unauthenticated (actions execute before any layout load). Nothing behind the hook
double-checks. Separately: no security headers or CSP anywhere; editors see customer
emails in the quiz editor and can edit the legal pages; the admin login has a per-IP-only
lockout, no second factor and week-long sessions; GDPR erasure misses mixed-case emails
stored verbatim from Stripe.

## Deliverables

1. **Guard on the resolved route.** Rewrite `handleAdminGuard` to derive its path from
   `event.route.id` (strip route groups: `/admin/(shell)/settings` → `/admin/settings`;
   `null` route → allow, the 404 handles it). Keep the session lookup for `/api/invoices/`
   and `/api/shipments/` on the same basis.
2. **Defense in depth.** Add `requireStaff(locals)` and `requireAdmin(locals)` to
   `src/lib/server/forms.ts` (throw `error(401/403)`), and call one of them FIRST in every
   admin form action and every `+server.ts` under `src/routes/admin/**` and
   `src/routes/api/shipments/**`. Remove every `locals.user!` assertion in favor of the
   helper's narrowed return. Editor-vs-admin section rules must hold for POST actions, not
   only GET.
3. **Security headers + CSP.** A `handleSecurityHeaders` hook (first in `sequence`) that
   sets `x-content-type-options`, `referrer-policy: strict-origin-when-cross-origin`,
   `x-frame-options: DENY`, `permissions-policy`, HSTS when `PUBLIC_SITE_URL` is https, and
   `cache-control: private, no-store` on `/admin`. CSP split as the audit describes: the
   static half in `kit.csp` (`script-src 'self' 'strict-dynamic'`, `style-src 'self'
   'unsafe-inline'`, `object-src 'none'`, `base-uri 'self'`, `mode: 'auto'`), the
   host-dependent half appended at runtime (`img-src` from `MEDIA_PUBLIC_BASE_URL` /
   `IMGPROXY_URL` + `data:`, `connect-src` analytics host + `S3_ENDPOINT` on admin routes
   only, `frame-src` the two sanitizer-allowlisted iframe hosts, **`form-action 'self'
   https://checkout.stripe.com`**, `frame-ancestors 'none'`). Ship it enforced, after
   proving on the preview build that checkout redirect, chat streaming, admin upload,
   analytics injection and the blurhash placeholders all work under it (SvelteKit strips
   `strict-dynamic` in dev — validate on `pnpm build && pnpm preview`, and stop the preview before ending the run). Add
   `ERROR`-free console assertions to the relevant e2e specs (no CSP violations).
4. **Role scoping.** Quiz editor loads `latestResults` (no emails) unless
   `locals.user.role === 'admin'`; the legal page slugs (or the whole `pages` section —
   pick one and document it) become admin-only in `ADMIN_ONLY_SECTIONS`.
5. **Login hardening.** A second login counter keyed by email only (reuse
   `consumeRateLimit` on `login_attempts` with a `email:` key, e.g. 20/h) so an attacker
   rotating IPs is bounded per account; `session.expiresIn` ≈ 12 h with `updateAge`; an
   append-only `admin_audit` table (actor, action, target, at) written for logins, CSV/zip
   exports, media deletes, nurture toggles and legal-page saves. TOTP for the `admin` role
   via better-auth's `twoFactor` plugin verified server-side in the login form action is
   the intended design — implement it if it fits the phase; otherwise record it as the
   next item in STATE.md with the exact plugin/API you validated.
6. **Erase completeness.** Lowercase the order email at write time
   (`shop/webhook.ts:192`) and the email sender's `to`; match `orders.email` and
   `email_log.to_email` on `lower(...)` with a supporting index (new migration); null
   `email_log.error` in the anonymize update.

## Tests

- **Hook-level regression (must FAIL on current code):** a request to
  `/%61dmin/subscribers/export.csv` and a `POST /%61dmin/pages/<id>?/save` (raw `fetch`
  with `accept: text/html`) through the built app or a `handle`-level harness answer
  303/401, never 200/303-with-effect. Plus the plain paths keep behaving as before.
- Integration: every admin action and endpoint returns 401 anonymous / 403 editor where
  admin-only — a table-driven spec over the route manifest so a new route cannot be added
  without a row.
- E2E: CSP enforced — checkout redirect to Stripe (mock gateway URL), chat stream, admin
  upload, consent-gated analytics stub, blurhash placeholder all pass with zero
  `securitypolicyviolation` events; response carries every header listed in (3).
- Integration: editor loading the quiz editor sees no subscriber email; editor POST to a
  legal page save → 403.
- Integration (racing): 20 parallel login attempts for one email from distinct IPs are
  capped by the email counter.
- Integration: erase anonymizes an order whose email was stored as `Ion.Popescu@Gmail.com`.

## Definition of Done

- [ ] Gate green; the encoded-path regression test pass, each added in a test-first commit that precedes its fix in `git log`.
- [ ] Every admin action/endpoint has an explicit `requireStaff`/`requireAdmin` call.
- [ ] Headers + CSP enforced on both sites; e2e green under them.
- [ ] Editor scoping, email-keyed lockout, session lifetime, audit table, erase fix in place.
- [ ] `pnpm db:migrate` clean on fresh and populated DBs; both `SITE_ID`s boot;
      STATE.md (+ DEPLOYMENT.md header notes) updated; work committed.
