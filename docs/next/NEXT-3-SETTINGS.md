# NEXT-3 — Site settings: the operator-editable data layer

Context: `docs/STATE.md` § "For the next phase" (settings is the last admin stub —
`src/routes/admin/(shell)/settings/+page.svelte` renders `StubPage.svelte`),
`LAUNCH-CHECKLIST.md` § Legal.

## Problem

Everything the launch checklist asks a human to "add to the site" — company identification
(name, CUI, Reg. Com., registered address, contact email/phone), ANPC and SOL links,
invoice series and starting number, VAT rate, shipping options — has nowhere to live. It is
per-deployment DATA (better-sleep and better-life are different legal entities), it must be
editable by the operator without a deploy, and the next three phases all need to read it.
There is no settings table and no settings screen.

## Deliverables

1. **`modules/settings`** with the module layout the codebase already uses (split
   `index.ts` / `server.ts` barrels; schema file; service with the logic; components).
   Storage: a single key/value table (`site_settings`: key text PK, value jsonb,
   updated_at, updated_by) — NOT one column per setting, so later phases add settings
   without a migration. No `site_id` column (one DB per site — that invariant is binding).
2. **A typed, validated registry** of known setting keys: each declares its key, a Zod-ish
   or hand-rolled validator, a default, whether it is required before launch, and whether
   it is safe to expose to the client. Reading an unknown key is a type error; reading a
   never-set key returns the declared default. Group at least:
   - `company.*` — legal name, CUI/VAT id, whether VAT-registered, Reg. Com. number,
     registered address, contact email, phone, IBAN/bank (optional).
   - `legal.*` — ANPC SAL URL, ANPC SOL URL, plus a free-text extra-notices field.
   - `invoice.*` — series prefix, next number, issuer place, default VAT rate in basis
     points, payment-terms note. (Consumed in NEXT-6; declare them here.)
   - `shop.*` — free-shipping threshold in bani, default shipping note. (Consumed in
     NEXT-8.)
3. **Server-side read path that is cheap.** Settings are read on nearly every request
   (footer). Load them once per request via `locals`/`event.locals` or a small
   request-scoped cache — never one query per component. Must be correct on a serverless
   instance: no module-level cache that outlives a deploy's config change without a TTL.
4. **`/admin/settings` screen** replacing the stub: grouped form sections, RO labels via
   paraglide messages, server-side validation with per-field errors, admin-role only
   (add to `ADMIN_ONLY_SECTIONS`), and an audit line on save (who/when). Follow the
   articles/products editors as the reference implementation.
5. **Client exposure is explicit**: only settings marked client-safe reach `PageData`.
   A test must prove a non-exposed setting cannot leak into the rendered HTML.
6. **Seed + validation for launch**: `pnpm db:seed` inserts placeholder values clearly
   marked as placeholders; `pnpm launch:check` (NEXT-2) gains a rule that every
   launch-required setting is set and is not still the placeholder.

## Tests

- Unit: registry validation — each setting's validator accepts its valid shape and rejects
  the obvious wrong ones (empty CUI, non-URL ANPC link, negative VAT rate, VAT rate > 100%).
- Unit: unknown key rejected; unset key returns the declared default.
- Integration: save through the admin action persists, re-read returns the new value, audit
  fields populated; invalid input re-renders with errors and writes nothing.
- Integration: `launch:check` fails while a required setting holds its seeded placeholder.
- Unit/integration: a non-client-safe setting is absent from the page payload.
- E2E: admin logs in, opens `/admin/settings`, saves company identification, value persists
  after reload. Editor-role user gets 403.

## Definition of Done

- [ ] Gate green; `pnpm db:migrate` clean on a fresh AND on a populated database.
- [ ] `StubPage.svelte` is no longer referenced by any route (it was the last stub).
- [ ] Settings read at most once per request; proven by a test that counts queries.
- [ ] `launch:check` enforces the launch-required settings.
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
