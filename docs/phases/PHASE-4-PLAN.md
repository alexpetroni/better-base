# Phase 4 — Quizzes, subscribers & email funnel

## Objective

The lead-generation core: formcomp-powered quizzes with scoring profiles,
GDPR-consented subscriber capture, and transactional email (quiz result +
newsletter opt-in) through a dry-run-capable Resend wrapper.

## Deliverables

1. **`modules/email`**: `sendEmail({ to, template, data, idempotencyKey })` —
   Resend under the hood, `EMAIL_DRYRUN=true` records to an `email_log` table
   (also written on real sends) instead of sending; idempotency by key (skip if
   already sent). Templates as typed functions returning subject + html + text
   (ro copy): `quiz-result`, `newsletter-confirm`. Migration for `email_log`.
2. **`modules/quiz` schema**: `quizzes` — id, slug, title, intro_md, pillar_id,
   form_schema (jsonb, formcomp schema), scoring (jsonb: bands/rules), status,
   result_template_key; `quiz_results` — id, quiz_id, subscriber_id (nullable
   FK), answers (jsonb), score, profile (jsonb: band + per-dimension breakdown),
   created_at. Migrations committed.
3. **Scoring engine**: pure function `(formSchema, scoring, answers) → profile`.
   Support at least: per-answer points, dimension sums, band thresholds with ro
   labels/advice text. Fully unit-tested.
4. **`subscribers` schema** (in quiz module or its own `modules/crm` — your
   call, document it): id, email (unique), name, locale, consents (jsonb:
   `{ newsletter: bool, profile_emails: bool }` each with timestamp + source),
   confirmed_at (double opt-in), unsubscribe_token, timestamps.
5. **Public quiz flow**: `/quiz/[slug]` renders the quiz with **formcomp**;
   on submit → results stored; email step: ask for email + explicit consent
   checkboxes (unticked by default — GDPR) → subscriber upserted, `quiz-result`
   email sent (idempotent per result), on-page result summary shown regardless
   of email opt-in.
6. **Newsletter**: signup component (footer + blog), double opt-in via
   `newsletter-confirm` email with signed token link; `/unsubscribe/[token]`
   one-click, updates consents.
7. **Admin**: `/admin/quizzes` — list, create/edit (title, pillar, form_schema
   + scoring as validated JSON editors with a "preview quiz" pane), results
   count per quiz, view latest results. `/admin/subscribers` — list, consent
   status, search, CSV export.
8. **Seed**: one real sleep screening quiz (~8–12 questions, sensible ro
   content, 3 result bands) so the funnel is demo-able.

## Steps

1. Email module + log + templates (dry-run tested).
2. Quiz schema + scoring engine (TDD — write the band/dimension tests first).
3. Public flow with formcomp; subscriber capture + consents.
4. Newsletter double opt-in + unsubscribe.
5. Admin screens + seed quiz.

## Tests

- Unit: scoring engine (bands, boundaries, missing answers), consent shaping,
  token sign/verify, email idempotency logic.
- Integration: submit quiz → result row + subscriber row + exactly ONE
  email_log entry even if the submit handler retries; unsubscribe flips consent.
- E2E: visitor completes the seeded quiz, sees the result page, enters email
  with newsletter consent; email_log holds quiz-result + newsletter-confirm
  (dry-run); confirm link confirms; unsubscribe link unsubscribes; admin sees
  the subscriber and the quiz result.

## Definition of Done

- [ ] Gate green; e2e above green with `EMAIL_DRYRUN=true`.
- [ ] No email ever sent by tests (assert wrapper honors dry-run).
- [ ] Consent checkboxes default unticked; result page works without giving an
      email; every consent change is timestamped with source.
- [ ] formcomp used as-is from `packages/formcomp` (fixes upstreamed into the
      package with their own tests, if needed).
- [ ] `docs/STATE.md` updated; all work committed.
