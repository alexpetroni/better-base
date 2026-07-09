# better-base — remediation mission & constitution

You are hardening the EXISTING, working better-base app (do not rebuild it). A full
adversarial audit is at **`docs/AUDIT-2026-07-09.md`** — read the sections relevant to
your phase; findings there cite exact `file:line`, the failure scenario, and the intended
fix. The original engineering constitution in **`PROMPT.md`** still binds (stack, module
layout, mock rules, DooD networking, test policy, honest-stop rule) — everything below is
in addition to it, not instead of it.

## What "done" means for this project

Every audit finding assigned to a phase is fixed, proven by a **regression test that fails
against the old behavior and passes after the fix**, with no regressions elsewhere. The
app must remain fully working for BOTH `SITE_ID=sleep` and `SITE_ID=life` at every phase
boundary.

## Binding rules for remediation work

- **Fix the root cause, not the symptom.** Where the audit calls something systemic
  (e.g. non-atomic counters in multiple files), fix it once in a shared place and update
  all call sites — do not patch one and leave the others.
- **Regression test first.** For each finding, add a test that reproduces the bug
  (concurrency race, missing timeout, dropped column, seq-scan-causing query, missing
  index, a11y gap, etc.) and demonstrates the fix. Concurrency findings need a test that
  actually races (parallel promises against the test DB), not a comment claiming safety.
- **Do not weaken existing tests to pass.** If a change breaks a test, fix the code or
  update the test only if the old assertion was wrong — and say so in the commit.
- **Migrations stay additive and committed.** New indexes/constraints/columns go in a new
  numbered drizzle migration that runs cleanly on a fresh DB AND on a populated one; never
  edit an already-committed migration.
- **No behavior change beyond the finding.** Keep diffs tight and reviewable; don't
  refactor unrelated code in a fix phase (the dedicated simplification phase handles that).
- **Preserve the invariants**: no `site_id` columns / no shared-DB assumptions; no brand
  string outside `config/sites`; secrets never reach client code; money in integer cents;
  cross-module imports respect whatever boundary policy the boundary phase establishes.
- **External services stay mocked in tests** (email dry-run, mock chat provider, mocked
  Stripe, local MinIO/imgproxy). Never call a paid/live service or use the runner's own
  credentials from the app or tests.

## Verification (also run as the independent gate after every phase)

`pnpm lint && pnpm check && pnpm test:unit` must pass from the repo root. Phases that
touch DB schema must also pass `pnpm db:migrate` on a fresh database. Phases with an e2e
deliverable run `pnpm test:e2e`. Never fake green: if a DoD item is genuinely unreachable,
STOP and write `BLOCKER.md` at the repo root (what's blocked, why, what you tried, what
input is needed) and exit nonzero.

## Per-phase bookkeeping

At the end of each phase, update **`docs/STATE.md`** with what changed, any new env vars
or scripts, new migrations, and anything the next phase must know. Commit in small
conventional-commit steps (`fix(shop): …`, `test(chat): …`, `perf(db): …`,
`refactor(core): …`). Do not push — the runner pushes.
