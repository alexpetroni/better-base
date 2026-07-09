# modules/quiz

formcomp-powered quizzes with jsonb form schemas + scoring configs, scored
results, and the email funnel that links results to `modules/crm` subscribers.

- `scoring.ts` — pure engine: per-answer point maps, numeric answers
  (clamped × multiplier, capped), dimension sums with ro labels, threshold
  bands (`min`, inclusive, ascending). `validateScoringConfig` returns ro
  errors for the admin JSON editor.
- `validate.ts` — structural form-schema validation WITHOUT runtime-importing
  the formcomp package (its barrel pulls .svelte files, which plain-node
  contexts like the seed script cannot load). Only `import type` from
  'formcomp' is allowed in this module's server-side files.
- `service.ts` — CRUD (unique ro slugs via the blog slug helpers), publish
  gate (`validateForPublish`), submission scoring/storage, admin listings.
- `funnel.ts` — `claimQuizResult`: upserts the subscriber (ticked boxes only —
  GDPR), links the result row, sends the transactional `quiz-result` email
  (idempotent per result+address, so retries never double-send but a corrected
  typo still gets its email) and starts newsletter double opt-in when asked.

Barrels: `$lib/modules/quiz` (scoring engine + validation + types, safe for
client code), `$lib/modules/quiz/server` (schema, services, funnel,
`getQuizFunnelDeps()`).
