# modules/email

Idempotent transactional email with dry-run support.

- `createEmailSender(...).send({ to, template, data, idempotencyKey })` claims
  the `idempotency_key` in `email_log` by insert — the same key can never
  deliver twice, even across concurrent retries. Failed (`error`) rows may be
  retried; `sent`, `dryrun` and in-flight `sending` rows are final.
- `EMAIL_DRYRUN` (default **true**): records to `email_log` and never touches
  the transport. Real delivery needs `EMAIL_DRYRUN=false` + `RESEND_API_KEY`.
- Templates are typed functions in `templates.ts` (`quiz-result`,
  `newsletter-confirm`) returning subject + html + text, ro copy, all
  interpolations HTML-escaped.

Barrels: `$lib/modules/email` (pure templates + types),
`$lib/modules/email/server` (sender, schema, `getEmailSender()` singleton).
