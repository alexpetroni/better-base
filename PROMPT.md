# better-base — mission & engineering constitution

You are building **better-base**: a modular, config-driven web platform that will be
deployed twice — first as **better-sleep** (sleep advice, quizzes, shop, blog, chat),
later as **better-life** (the same features across 9 "pillars of a better life", of
which sleep is one). Romanian market, Romanian as base language.

## Product architecture (binding decisions — do not revisit)

- **One codebase, one schema, N databases.** Each site is a deployment of the same
  app selected by `SITE_ID` (`sleep` | `life`) with its **own** `DATABASE_URL`.
  The database schema is identical everywhere; only data differs. There are NO
  `sites` tables and NO `site_id` columns anywhere. A site never queries or knows
  about another site's data.
- **Pillars are data + config, not code.** A `pillars` table is seeded per site
  (better-sleep: 1 row; better-life: 9). Content (articles, products, quizzes) is
  tagged to pillars via join tables. All listing queries filter by the active
  site's pillars from config.
- **Site config** lives in `apps/web/src/lib/config/sites/{sleep,life}.ts`:
  domain, active pillar slugs, theme tokens, nav, chat persona key, email sender.
  `SITE_ID` env var selects it at startup. Everything brand-specific derives from
  this config — never hardcode a brand string in a route or component.
- **Modules as folders**, one per feature, under `apps/web/src/lib/modules/`:
  `blog/`, `quiz/`, `shop/`, `chat/`, `email/`, `media/`, `auth/`. Each module owns
  its Drizzle schema file, server services, and components. Cross-module imports go
  ONLY through the module's `index.ts` barrel. Routes stay thin — they call module
  services.
- **Admin is part of the app** at `/admin`, role-gated (`admin`/`editor` staff
  users via better-auth). No external CMS.
- **Media**: originals in an S3-compatible bucket (dev: MinIO via docker compose;
  prod: Cloudflare R2), transformed on the fly by **imgproxy** (dev: docker compose
  container) using signed URLs. The app never serves image bytes itself.

## Stack (fixed)

- SvelteKit 2 + **Svelte 5 runes only** (no legacy `$:`/`export let` component APIs),
  Tailwind CSS v4 via `@tailwindcss/vite`, TypeScript strict.
- pnpm workspace: `apps/web` + `packages/formcomp` (the quiz form library —
  already vendored at `packages/formcomp`, treat as an internal dependency; you may
  fix bugs in it but do not rewrite it).
- Postgres 16 + Drizzle ORM (`drizzle-kit` migrations committed to the repo).
- Stripe Checkout (test mode) for the shop; Resend for email behind an idempotent
  wrapper with `EMAIL_DRYRUN=true` support; Paraglide JS for i18n (base locale `ro`).
- Chat: Anthropic API behind a provider interface (see mock rules).

## Environment you run in

You are inside a Docker container with the repo mounted and access to the HOST
docker daemon (docker-out-of-docker). Consequences:

- Containers you start with `docker compose up` are SIBLINGS. Their published
  ports live on the host: reach them at **`host.docker.internal:PORT`**, never
  `127.0.0.1`. This applies to Postgres, MinIO, imgproxy, and any preview server
  you curl from a separate shell.
- Therefore all connection strings must come from env vars. In the `.env` YOU
  create and use, point hosts at `host.docker.internal`. In `.env.example`,
  document `localhost` (what a human on the host uses). Never hardcode either.
- The app's own dev server / vitest run INSIDE your container, so the app reaches
  Postgres at `host.docker.internal:5432` too (via `DATABASE_URL` from your `.env`).

## Mock & external-service rules

Never call paid or external services from tests:

- **Email**: all sends go through `modules/email` which honors `EMAIL_DRYRUN=true`
  (log + record instead of send). Tests always run dry.
- **LLM**: chat uses a `ChatProvider` interface; tests and dev-default use
  `MockChatProvider` (deterministic canned responses). The Anthropic provider is
  selected only when `ANTHROPIC_API_KEY` is set AND `CHAT_PROVIDER=anthropic`.
  NEVER use the agent-runner's own credentials for the app.
- **Stripe**: real SDK in test mode only for manual verification; automated tests
  mock the Stripe client and construct signed webhook payloads with the SDK's
  signing helper against a test webhook secret.
- **Storage/imgproxy**: tests run against the local MinIO + imgproxy containers
  (they are free) or pure functions (URL signing is unit-testable offline).

## Quality bar & test policy

- `pnpm lint && pnpm check && pnpm test:unit` must pass from the repo root at the
  end of every phase — this exact command is also run as an independent gate.
- **Unit tests (vitest)** for every service function with logic (scoring, signing,
  slugs, consent, money math). Integration tests that need Postgres use the
  compose database with a dedicated `*_test` database, migrated fresh per run.
- **E2E (playwright)** happy-path per module where the phase plan says so, run
  with `pnpm test:e2e` against a built preview server. E2E is part of the phase's
  DoD but not the gate.
- Migrations are additive and committed; `pnpm db:migrate` must run cleanly on a
  fresh database at any commit.
- No `any` escapes, no `@ts-ignore` without a one-line justification comment.
- Both site configs must always boot: `SITE_ID=sleep` and `SITE_ID=life` are both
  exercised by at least one smoke test from Phase 0 on.

## Working rules

- Execute ONLY the phase you are given. If you finish early, improve that phase's
  tests — do not start the next phase.
- Commit in small conventional-commit steps (`feat(shop): …`, `test(quiz): …`).
  Do not push; the runner pushes.
- Never fake a green result. If a DoD item is genuinely unreachable (missing
  credential, broken upstream, contradictory requirement), STOP and write
  `BLOCKER.md` at the repo root explaining what is blocked, why, what you tried,
  and what decision/input is needed — then exit nonzero.
- Update `docs/STATE.md` at the end of each phase: what exists, key commands,
  env vars added, anything the next phase must know.
