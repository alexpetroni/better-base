# NEXT-2 — Deploy pipeline: CI migrations, launch preflight, imgproxy host

Context: `docs/NEXT-VERCEL-NEON.md` steps 3–5, `DEPLOYMENT.md` §9 and §12,
`LAUNCH-CHECKLIST.md`. Depends on NEXT-1.

## Problem

Three things stand between the Vercel/Neon branch and a deploy a human can execute without
improvising:

- **Migrations have no home.** They must not run during the Vercel build, so today they are
  "run them from a checkout" — an unrepeatable manual step with no record of what ran
  against production.
- **imgproxy has nowhere to run.** Vercel cannot host it and every image on every page is a
  signed imgproxy URL. The decision was deferred; the deployment is not executable until
  there is a concrete, config-in-repo answer.
- **`LAUNCH-CHECKLIST.md` has a "grep-check that no dev-default secret reached prod" box**
  that nobody can honestly tick by hand — the dev defaults are spread across
  `.env.example`, compose and code.

## Deliverables

1. **GitHub Actions migration workflow** (`.github/workflows/migrate.yml`): runs
   `pnpm db:migrate` against `DIRECT_DATABASE_URL` from repository secrets, on manual
   dispatch AND on push to the production branch before Vercel promotes. It must: fail
   closed if the secret is absent, print the applied migration list, and be a no-op when
   the database is already current. Document how a human wires the secrets.
2. **`pnpm launch:check`** — a preflight script (`apps/web/scripts/launch-check.ts`)
   run against a target environment's env, exiting non-zero with a numbered report. It
   checks at minimum:
   - every required env var for the selected `DEPLOY_TARGET` is present and non-empty
     (drive this from ONE env matrix used by both the script and the fail-fast boot
     validation added in FIX-6 — do not write a second list that can drift);
   - no value equals a known dev default (auth secret, token secret, imgproxy key/salt,
     MinIO credentials, Stripe test keys when `EMAIL_DRYRUN=false`/live mode);
   - `PUBLIC_SITE_URL` is https and matches the site config domain for `SITE_ID`;
   - `EMAIL_DRYRUN=false` implies `RESEND_API_KEY`; `CHAT_PROVIDER=anthropic` implies
     `ANTHROPIC_API_KEY`; a Vercel target implies `CRON_SECRET` and `DIRECT_DATABASE_URL`;
   - imgproxy: `IMGPROXY_URL` is reachable and answers a signed URL with 200 and an
     unsigned one with 403 (proves key/salt agree between app and imgproxy — the single
     most likely silent prod breakage).
3. **imgproxy deployment, decided and committed.** Pick ONE host (Fly.io is the
   recommendation unless you find a blocker: it runs the upstream image, has a RO-adjacent
   region, and costs cents) and commit its config — e.g. `deploy/imgproxy/fly.toml` plus a
   README with the exact `fly secrets set` lines for `IMGPROXY_KEY`, `IMGPROXY_SALT` and
   the read-only R2 credentials, the health check, and the Cloudflare "Cache Everything"
   rule from §6. State the decision and its cost/alternatives in `DEPLOYMENT.md` §12.
4. **Merge readiness**: `DEPLOY_TARGET=vercel pnpm build` and the default build both green;
   `LAUNCH-CHECKLIST.md` Ops section rewritten for whichever target the operator picks —
   the `pnpm chat:prune` cron box must become target-conditional (machine cron vs
   `vercel.json` schedule + `CRON_SECRET`), because on Vercel the current wording is wrong.

## Tests

- Unit: `launch:check` against a fixture env — a complete prod-shaped env passes; each
  individual defect (missing var, dev-default value, http site URL, target/secret
  mismatch) produces a distinct non-zero failure. Table-driven, one case per rule.
- Unit: the env matrix is single-sourced — a test asserts the boot validator and
  `launch:check` derive from the same declaration (add a var to the matrix and both see it).
- Integration: the imgproxy signed/unsigned probe against the local container (200 / 403).
- The workflow YAML is parsed and asserted in a test (job runs on the right trigger, uses
  `DIRECT_DATABASE_URL`, has no `pnpm db:seed` in it) — a broken deploy workflow is not
  detectable any other way from here.

## Definition of Done

- [ ] Gate green; `pnpm test:neon` still green.
- [ ] `pnpm launch:check` passes against the local dev env with a `--dev` acknowledgement
      and FAILS (with a readable report) against an env that carries any dev default.
- [ ] imgproxy host chosen, its config committed under `deploy/`, decision + cost recorded.
- [ ] `.github/workflows/migrate.yml` exists, fails closed without secrets, documented.
- [ ] `DEPLOYMENT.md` §12 and `LAUNCH-CHECKLIST.md` updated so a human can execute the
      deploy top-to-bottom without inventing a step.
- [ ] Both builds green; STATE.md updated; work committed.
