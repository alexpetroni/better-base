# modules/settings

Operator-editable, per-deployment site settings: company identification, ANPC/SOL
links, invoice series and VAT rate, shop shipping knobs. better-sleep and
better-life are different legal entities on the same code, so none of this may be
a string literal in a route or component — it is DATA, edited at `/admin/settings`.

- **Storage** — `site_settings`: one `key` (text PK) / `value` (jsonb primitive)
  row per setting, plus `updated_at` / `updated_by` for the audit line. Later
  phases add settings by adding a registry entry — no migration.
- **`registry.ts`** — THE declaration of every known key: kind (drives the form
  control and the hand-rolled validator), default, `launchRequired` (enforced by
  `pnpm launch:check`), `clientSafe` (may reach `PageData`), and the seeded
  placeholder text. Reading an unknown key is a compile-time error; reading a
  never-set key returns the declared default.
- **Read path** — `hooks.server.ts` puts a request-scoped lazy loader on
  `event.locals.settings`; however many loads call it, the request costs at most
  ONE query, and nothing is cached across requests (serverless-safe). The public
  layout exposes `clientSafeSettings(...)` as `data.publicSettings`; everything
  else stays server-only.
- **Audit** — every successful save from `/admin/settings` writes one
  `admin_audit` row (`settings-save`: actor, group, changed keys; old → new for
  `company.iban`/`company.bank`, FIX-18); a save that changes nothing writes
  none. `company.iban` is mod-97 checked (`util/iban.ts`) and stored in its
  canonical form (upper case, no spaces).
- **Money/VAT** — amounts are integer bani, VAT rates integer basis points; the
  admin form converts via `parseLeiToCents` ("21" → 2100), so no float ever
  touches a stored value.
- **Seed** — `pnpm db:seed` inserts `PLACEHOLDER — …` rows for launch-required
  text keys (never overwriting operator edits); `pnpm launch:check` (without
  `--dev`/`--no-probe`) fails while any launch-required key is unset, still a
  placeholder, or invalid.
