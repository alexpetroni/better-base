# modules/crm

Subscribers + GDPR consents + the newsletter double opt-in funnel. The phase
plan left the choice of home for `subscribers` open (quiz module vs. its own
module) — it lives HERE because newsletter signup exists independently of
quizzes; the quiz module links results to subscribers through this module.

- `subscribers`: one row per email. `consents` jsonb holds
  `{ newsletter, profile_emails }`, each `{ granted, at, source }` plus, for
  visitor-made grants, `ip`, `userAgent` and `consentTextVersion` (the copy
  the visitor saw, `<message key>@<version>` from `CONSENT_TEXT_VERSIONS` —
  bump the version when the wording changes) — every change timestamped,
  attributable and provable. Callers pass only explicit intents: an unticked
  checkbox never revokes an earlier grant.
- Double opt-in: `requestNewsletterSignup` records consent and emails a
  signed, expiring confirm token (HMAC, `token.ts`); the confirm page's GET
  only verifies the token (`verifyNewsletterConfirmToken`), its POST calls
  `confirmSubscriber`, which stamps `confirmed_at` once. Newsletter-mailable =
  consent AND confirmed. The public form answers "check your inbox" for new
  AND already-confirmed addresses (no confirmed-status oracle).
- Unsubscribe: the per-row `unsubscribe_token` (never expires) drives
  `/unsubscribe/[token]`: GET renders a confirmation, POST (the button, or the
  RFC 8058 one-click `List-Unsubscribe=One-Click` mail clients send to the
  same URL) calls `unsubscribeByToken`, revoking ALL consents with source
  `unsubscribe` AND clearing `confirmed_at` — a later re-grant needs a fresh
  double opt-in. `revokeConsentsByEmail` does the same for provider feedback
  (`bounce`/`complaint`, the Resend webhook).

Barrels: `$lib/modules/crm` (NewsletterSignup component, consent shaping),
`$lib/modules/crm/server` (schema, services, tokens, `getTokenSecret()`).
