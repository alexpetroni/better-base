# Working in better-base

Read `PROMPT.md` first — it is the engineering constitution (stack, module
layout, site-config rule, mock rules, test policy) and binds every change.
Then `docs/STATE.md` (where we are), `docs/ARCHITECTURE.md` (boundaries) and
`docs/RUNBOOK.md` (commands and environment quirks).

## Boundary rules that reviewers check

- Cross-module imports go through the barrel only: `$lib/modules/<name>` or
  `$lib/modules/<name>/server`. ESLint enforces it; do not add exceptions.
- Nothing brand-, company- or country-specific in code: site config
  (`src/lib/config/sites/*`) or `site_settings` data.
- Money is integer bani; fiscal records are append-only; external side
  effects are idempotent; providers sit behind an interface with a mock.
- Migrations are additive, in a new numbered file, never edited once
  committed; large-table indexes go through `concurrent-indexes.ts`
  (`docs/MIGRATIONS.md`).
- Secrets never reach client code or a command line (`--password-stdin`).

## How to work

- Test-first for fixes: the failing test commits before the fix.
- Gate before you finish: `pnpm lint && pnpm check && pnpm test:unit`.
- Both `SITE_ID=sleep` and `SITE_ID=life` must boot; both adapters and both
  `DB_DRIVER`s must build.
- Never run prettier on `docs/*.md`. Installs need
  `pnpm --store-dir .pnpm-store …`. Compose services are siblings:
  `host.docker.internal:PORT` from an agent container.
- Record what you closed or deferred in `docs/STATE.md`; move the previous
  phase's section to `docs/CHANGELOG.md`.
