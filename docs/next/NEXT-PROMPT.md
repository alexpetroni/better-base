# better-base — launch-completion mission & constitution

You are finishing the EXISTING, working better-base app (do not rebuild it). The original
engineering constitution in **`PROMPT.md`** still binds in full (stack, module layout,
site-config rule, mock rules, DooD networking, test policy, honest-stop rule) — everything
below is in addition to it, not instead of it.

Read before your phase: `docs/STATE.md` (what exists and why — it is long; read the
sections your phase touches), `DEPLOYMENT.md`, `LAUNCH-CHECKLIST.md`, and
`docs/NEXT-VERCEL-NEON.md`.

## What this batch is for

`docs/STATE.md` § "Known gaps / suggested next phases" plus `LAUNCH-CHECKLIST.md` list what
stands between the current build and a real better-sleep launch on the Romanian market.
This batch closes every gap that is CODE work. It deliberately does not attempt the
human-only items (lawyer review, company accounts, DNS, live Stripe keys, a real card
purchase) — where a human step is unavoidable, the phase's job is to make it a
short, documented, verifiable checklist entry rather than to fake it.

## What "done" means for this batch

- better-sleep can be launched legally in Romania: an order produces a compliant invoice,
  the site carries the legally required company identification and ANPC/SOL links, and the
  operator knows exactly which human steps remain.
- Every deliverable is proven by a test that fails against the old behavior and passes
  after the change. No deliverable is "done" because the code looks right.
- The app remains fully working for BOTH `SITE_ID=sleep` and `SITE_ID=life` at every phase
  boundary, and on BOTH deployment targets (`adapter-node` default and
  `DEPLOY_TARGET=vercel`), and under BOTH `DB_DRIVER=pg` and `DB_DRIVER=neon`.

## Binding rules for this batch

- **Nothing brand-, company- or country-specific gets hardcoded.** Company identification,
  invoice series, VAT rate, ANPC/SOL URLs and shipping options are DATA (site settings rows
  or `config/sites/*`), never string literals in a route or component. better-life is a
  different legal entity on the same code.
- **Money stays integer cents (bani).** `modules/shop/money.ts` remains the only place
  amounts meet strings. VAT math is integer math; document the rounding rule and test it at
  the boundary cases.
- **Financial records are append-only.** An issued invoice is never mutated and never
  deleted — corrections are new documents (storno). GDPR erasure anonymizes the customer
  record but must NOT destroy legally retained accounting data; where the two collide,
  implement the split and document it.
- **Idempotency everywhere a retry is possible.** Webhooks, cron jobs and email sends must
  be safe to run twice. Derive idempotency keys from row ids or stable timestamps stored on
  the row — never from `new Date()` inside a handler.
- **External providers behind an interface + mock**, like `ChatProvider` and
  `StripeGateway` already are. Courier/AWB and analytics are new instances of that same
  pattern: real adapter selected only when its credentials are present, deterministic mock
  otherwise; tests only ever touch the mock. Never use the runner's own credentials.
- **Serverless-compatible.** Anything you add must work on Vercel: no local filesystem
  writes at runtime (use the S3 bucket), no in-process timers or background queues (use the
  cron route seam in `src/routes/api/cron/`), no assumption of a long-lived process.
- **Migrations stay additive and committed**; never edit a committed migration. Every new
  migration must run cleanly on a fresh DB and on a populated one.
- **No behavior change beyond your phase's deliverables.** Keep diffs tight and reviewable.

## Verification (also run as the independent gate after every phase)

`pnpm lint && pnpm check && pnpm test:unit` must pass from the repo root.

Integration tests need the local stack — `docker compose up -d` including **imgproxy**, or
the media specs fail with `ECONNREFUSED :8888`. Compose services are siblings: reach their
published ports at `host.docker.internal:PORT`. You do not need to edit `.env` —
`loadRootEnv()` / `src/lib/config/hosts.ts` normalizes service hosts for wherever the
process runs.

Phases that touch schema must also pass `pnpm db:migrate` on a fresh database. Phases with
an e2e deliverable run `pnpm test:e2e`.

**Never fake green.** If a DoD item is genuinely unreachable (missing credential, upstream
that cannot be mocked honestly, contradictory requirement), STOP: write `BLOCKER.md` at the
repo root — what is blocked, why, what you tried, what decision or input is needed — and
exit nonzero. Deliver every other item in the phase first.

## Known environment gotchas (each of these has already cost a session)

- **pnpm**: `node_modules` links to the repo-local store — installs need
  `pnpm --store-dir .pnpm-store …` or they fail with `ERR_PNPM_UNEXPECTED_STORE`.
- **Do not run prettier on `docs/*.md`.** Repo lint runs from `apps/web`, so these files
  were never formatted; prettier reflows the prose and has corrupted a list before.
- **Block comments**: a `*/` inside a JSDoc path (e.g. `modules/*/token.ts`) closes the
  comment and fails the build.
- **E2E login**: use `login`/`submitLogin` from `e2e/helpers.ts` and wait for the
  `data-hydrated` marker before typing into server-echoed inputs.
- **Form-action requests from playwright** need `accept: text/html`, else SvelteKit answers
  with the JSON action protocol instead of a 303.

## Per-phase bookkeeping

At the end of each phase update **`docs/STATE.md`** (what changed, new env vars, new
scripts, new migrations, anything the next phase must know) and, where the phase changes
what a human must do at launch, update **`LAUNCH-CHECKLIST.md`** and **`DEPLOYMENT.md`**
in the same commit. Commit in small conventional-commit steps (`feat(invoice): …`,
`test(shop): …`, `docs: …`). Do not push — the runner pushes.
