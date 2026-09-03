# better-base — remediation batch 2 (September 2026) — mission & constitution

You are hardening the EXISTING, working better-base app (do not rebuild it). The second
critical review is at **`docs/AUDIT-2026-09-03.md`** — read the sections your phase names;
every finding there cites `file:line` (relative to `apps/web/`), the concrete failure
scenario and the intended fix. The engineering constitution in **`PROMPT.md`** still binds
in full (stack, module layout, site-config rule, mock rules, DooD networking, test policy),
and so do the product rules of **`docs/next/NEXT-PROMPT.md`** § "Binding rules for this
batch" (data not code for anything brand/country-specific, integer bani, append-only
fiscal records, idempotency, providers behind an interface + mock, serverless-compatible,
additive migrations). Where those two files describe HOW to stop on a blocker
(`BLOCKER.md`, exit nonzero), that mechanism is superseded by the runner instructions
appended below this file: report status `blocked` in the structured report instead.

Read before your phase: the audit sections you are assigned; `docs/STATE.md` (long — read
the module sections your phase touches); the module `README.md` files under
`apps/web/src/lib/modules/<name>/` for the modules you change.

## What "done" means for this batch

- Every audit finding assigned to the phase is fixed at the root cause and proven by a
  **regression test that reproduces the audit's failure scenario**. Commit test-first: the
  commit that adds the failing test precedes the commit that makes it pass, so the
  sequence is visible in `git log` to anyone verifying the phase. Concurrency and ordering
  findings need tests that actually race or reorder events against the test database,
  not comments claiming safety.
- The app stays fully working for BOTH `SITE_ID=sleep` and `SITE_ID=life`, on BOTH
  deployment targets (`adapter-node` and `DEPLOY_TARGET=vercel`), under BOTH
  `DB_DRIVER=pg` and `DB_DRIVER=neon`, at every phase boundary.
- No behavior change beyond the phase's deliverables. Keep diffs tight and reviewable.
  Where the audit lists a P2 next to your P0/P1 work in the same file, take it only if the
  phase plan names it.

## Binding rules for remediation work

- **Fix once, in the shared place.** Where the audit calls something systemic (the admin
  guard, the email-log claim semantics, the launch-check rule set), fix it centrally and
  update every call site — never patch one path and leave a sibling.
- **Do not weaken existing tests to pass.** If a change breaks a test, fix the code, or
  fix the test only when its old assertion was wrong — and say so in the commit message.
  The e2e assertion on the `/en/` hreflang (`e2e/frontend.e2e.ts`) is one such case; the
  audit explains why, and the phase that owns it names the replacement assertion.
- **Migrations stay additive and committed**, in a new numbered drizzle file; never edit a
  committed migration. New indexes on tables that may already be large go through the
  out-of-transaction path the pipeline phase establishes (until then, note it in STATE.md).
- **Money stays integer bani; fiscal records stay append-only.** A refund correction is a
  NEW document (storno), never a mutation. VAT math stays integer.
- **Secrets never reach client code; nothing brand/company/country-specific is hardcoded.**
- **External services stay mocked in tests** (email dry-run, mock chat provider, mocked
  Stripe with SDK-signed webhook payloads, mock courier, local MinIO). Never call a paid or
  live service; never use the runner's own credentials from the app or tests.
- **The audit document and the plan files are read-only for you.** Record what you closed,
  deferred or disagreed with in `docs/STATE.md`, not by editing them.

## Verification commands (run them yourself to completion; the reviewer re-runs them)

- `pnpm lint && pnpm check && pnpm test:unit` from the repo root — the runner's gate.
- Phases that touch schema: `pnpm db:migrate` on a fresh database AND on a populated one.
- Phases with an e2e deliverable: `pnpm test:e2e` (builds, then runs the preview servers
  for both sites; the command exits on its own).
- Integration tests need the local stack: `docker compose up -d` (Postgres + MinIO;
  imgproxy and the Neon proxy are behind compose profiles and are NOT needed unless the
  phase says so). Compose services are siblings: reach their published ports at
  `host.docker.internal:PORT`. Do not edit `.env` — `loadRootEnv()` normalizes hosts.
- If you start a dev or preview server by hand (for a CSP or headers check), stop it
  before you end your turn; nothing may still be running when the run ends.

If a Definition of Done item is genuinely unreachable (missing credential, an upstream that
cannot be mocked honestly, a contradictory requirement), deliver every other item, commit,
and report status `blocked` with what is missing — never fake green, never soften the DoD.

## Known environment gotchas (each has already cost a session)

- **pnpm**: `node_modules` links to the repo-local store — installs need
  `pnpm --store-dir .pnpm-store …` or fail with `ERR_PNPM_UNEXPECTED_STORE`.
- **Do not run prettier on `docs/*.md`** — repo lint runs from `apps/web`; prettier reflows
  the prose and has corrupted a list before.
- **Block comments**: a `*/` inside a JSDoc path (`modules/*/token.ts`) closes the comment
  and fails the build.
- **E2E login**: use `login`/`submitLogin` from `e2e/helpers.ts` and wait for the
  `data-hydrated` marker before typing into server-echoed inputs.
- **Form-action requests from playwright or curl** need `accept: text/html`, else SvelteKit
  answers with the JSON action protocol instead of a 303.
- **The admin guard bypass (FIX-9) is reproduced with a raw request**, not a browser: a
  browser normalizes `%61` before sending. Test it with `fetch`/`curl` against the preview
  server or with a hook-level unit test on `handle`.
- **Do not `git checkout .`, `reset --hard`, `clean -f`, rebase or push** — the runner's
  hook refuses them; revert a single file by name if you must.

## Per-phase bookkeeping

At the end of each phase update **`docs/STATE.md`** (what changed, new env vars, scripts,
migrations, anything the next phase must know, and a short "Closed by FIX-N" list of the
audit findings you closed or deliberately deferred) and, where the phase changes what a
human must do at launch, **`LAUNCH-CHECKLIST.md`** and **`DEPLOYMENT.md`** in the same
commit. Commit in small conventional-commit steps (`test(auth): …` then `fix(auth): …`,
`docs: …`). Do not push — the runner pushes after the phase is independently verified.
