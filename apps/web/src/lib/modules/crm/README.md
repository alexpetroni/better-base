# modules/crm

Subscribers + GDPR consents + the newsletter double opt-in funnel. The phase
plan left the choice of home for `subscribers` open (quiz module vs. its own
module) — it lives HERE because newsletter signup exists independently of
quizzes; the quiz module links results to subscribers through this module.

- `subscribers`: one row per email. `consents` jsonb holds
  `{ newsletter, profile_emails }`, each `{ granted, at, source }` — every
  change timestamped and attributable. Callers pass only explicit intents:
  an unticked checkbox never revokes an earlier grant.
- Double opt-in: `requestNewsletterSignup` records consent and emails a
  signed, expiring confirm token (HMAC, `token.ts`); `confirmSubscriber`
  stamps `confirmed_at` once. Newsletter-mailable = consent AND confirmed.
- Unsubscribe: the per-row `unsubscribe_token` (never expires) drives
  one-click `/unsubscribe/[token]`, revoking ALL consents with source
  `unsubscribe`.

Barrels: `$lib/modules/crm` (NewsletterSignup component, consent shaping),
`$lib/modules/crm/server` (schema, services, tokens, `getTokenSecret()`).
