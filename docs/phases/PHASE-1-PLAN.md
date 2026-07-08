# Phase 1 — Auth & admin shell

## Objective

Staff authentication (better-auth) with roles, a protected `/admin` area with the
navigation shell all later admin screens plug into, and a CLI to create the first
admin user.

## Deliverables

1. **`modules/auth`**: better-auth configured with Drizzle adapter (email +
   password, sessions in Postgres), schema migration committed. Staff `users`
   carry `role: 'admin' | 'editor'`. Public signup is DISABLED — users are
   created only via CLI or by an admin.
2. **CLI**: `pnpm user:create -- --email … --password … --role admin` (idempotent
   on email; validates password length ≥ 12).
3. **Login/logout**: `/admin/login` page (rate-limited: 5 attempts / 15 min per
   IP+email, in-DB counter), logout action, session cookie httpOnly/secure/lax.
4. **Guarding**: server hook (or `/admin` layout server load) rejects
   unauthenticated access to everything under `/admin` except `/admin/login`;
   `editor` role sees content sections only (products/orders/subscribers/settings
   nav hidden and routes 403) — enforce server-side, not just in the UI.
5. **Admin shell**: `/admin` layout — sidebar nav (Articles, Products, Quizzes,
   Media, Subscribers, Orders, Settings — entries appear as later phases land;
   stub pages saying "coming in phase N" are fine), header with site name from
   config + current user + logout. Dashboard landing with placeholder stat cards.
6. **`docs/STATE.md`** updated (auth flow, how to create users, role rules).

## Steps

1. Install/configure better-auth + Drizzle adapter; migration; user:create CLI.
2. Build login page + hook guard + role checks.
3. Build the admin layout shell and stub pages.

## Tests

- Unit: role guard logic (admin passes everywhere; editor blocked on
  admin-only sections; anonymous redirected), rate-limit counter logic.
- Integration (test DB): user:create idempotency; session created on valid
  login, not on invalid.
- E2E: anonymous → `/admin` redirects to login; wrong password stays out (and
  6th attempt rate-limited); valid admin login lands on dashboard, sidebar
  visible, logout returns to login; editor visiting an admin-only stub gets 403.

## Definition of Done

- [ ] Gate green (`pnpm lint && pnpm check && pnpm test:unit`); e2e above green.
- [ ] `pnpm user:create` works against a fresh migrated DB.
- [ ] Every `/admin` route is server-side protected — verified by e2e, not by
      inspection.
- [ ] Works under both `SITE_ID`s (auth is site-agnostic; smoke boot both).
- [ ] `docs/STATE.md` updated; all work committed.
