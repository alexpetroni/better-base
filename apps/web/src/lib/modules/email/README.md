# modules/email

Idempotent transactional email with dry-run support.

- `createEmailSender(...).send({ to, template, data, idempotencyKey })` claims
  the `idempotency_key` in `email_log` by insert — the same key can never
  deliver twice, even across concurrent retries. `sent` is final; `error`
  rows may be retried; a `sending` claim is re-claimable after
  `EMAIL_SENDING_STALE_MS` (10 min — a serverless kill between claim and
  transport); a `dryrun` row is a RECORD, not a delivery — final only while the
  sender itself runs dry, so the dry-run soak before launch never burns a key.
  The reclaim `UPDATE` repeats the rule in its `WHERE`, so concurrent retries
  elect exactly one sender.
- `EMAIL_DRYRUN` (default **true**): records to `email_log` and never touches
  the transport. Real delivery needs `EMAIL_DRYRUN=false` + `RESEND_API_KEY`.
- Templates are typed functions in `templates.ts` (`quiz-result`,
  `newsletter-confirm`) returning subject + html + text, ro copy, all
  interpolations HTML-escaped.

Barrels: `$lib/modules/email` (pure templates + types),
`$lib/modules/email/server` (sender, schema, `getEmailSender()` singleton).
