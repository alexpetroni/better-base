# Phase 7 — Hardening & launch readiness (better-sleep first)

## Objective

Close the gaps between "features work" and "site can launch": cross-site smoke,
legal/GDPR surface, accessibility & performance pass, content export/import
CLI, deployment docs, and a verified launch checklist for better-sleep.

## Deliverables

1. **Full-funnel e2e** (both `SITE_ID`s): home → pillar page → article → quiz →
   subscribe (dry-run email) → shop → cart → mocked checkout → chat message.
   One spec file per site config, run in `pnpm test:e2e`.
2. **Content export/import CLI**: `pnpm content export --type article|quiz|product
   --slug X` → JSON (incl. referenced media descriptors) and `pnpm content
   import file.json` (idempotent by slug; re-uploads media to the target
   bucket). This is the cross-site content sharing mechanism. Tested against
   two databases (export from A, import into B, import twice → no dupes).
3. **Legal/GDPR surface**: cookie consent banner (analytics off until consent;
   no analytics script shipped yet — just the consent state + hook point),
   privacy policy & terms pages as DB-backed simple pages editable in admin
   (`/admin/pages` minimal), links in footer from config; data-deletion note:
   `pnpm subscriber:delete -- --email …` CLI (erases subscriber + anonymizes
   their quiz results/orders email).
4. **Accessibility pass**: axe checks in playwright on home, blog list/article,
   quiz, product, cart, chat — zero serious/critical violations.
5. **Performance pass**: images sized via imgproxy everywhere (no raw
   originals in HTML — test greps rendered pages), fonts self-hosted +
   `font-display: swap`, no layout-shifting hero, `pnpm build` bundle review
   noted in STATE.md.
6. **Error & ops hygiene**: custom error page, `/api/health` (checks DB +
   storage reachability), structured server logging of unhandled errors,
   graceful 404s.
7. **Docs**: `DEPLOYMENT.md` — deploying `SITE_ID=sleep` (and later `life`):
   env matrix per site (two DBs, two buckets, shared imgproxy), migrate+seed
   steps, Stripe webhook setup, R2 setup, imgproxy prod config + Cloudflare
   cache note, cron entries (chat prune). `LAUNCH-CHECKLIST.md` for
   better-sleep with every manual step (DNS, Stripe live keys, Resend domain,
   legal copy review) — checkboxes, honest about what needs a human.

## Steps

1. Export/import CLI (it exercises every module's data model — do it first;
   it will flush out schema issues).
2. Full-funnel e2e both sites; fix whatever it finds.
3. GDPR surface + pages + deletion CLI.
4. a11y + performance passes.
5. Health/error hygiene + docs.

## Tests

- The full-funnel e2e specs ARE the test deliverable, plus: export/import
  round-trip integration test (two test DBs), subscriber deletion integration
  test (rows gone/anonymized), axe assertions, health endpoint test (DB down →
  503, verified by stopping the container or pointing at a bad URL).

## Definition of Done

- [ ] Gate green; FULL e2e suite green for `SITE_ID=sleep` AND `SITE_ID=life`
      from a fresh `docker compose up` + migrate + seed.
- [ ] Export→import of an article, a quiz, and a product between two fresh DBs
      round-trips (integration-tested).
- [ ] Zero serious/critical axe violations on the listed pages.
- [ ] `DEPLOYMENT.md` complete enough that a human can deploy better-sleep
      without reading source; `LAUNCH-CHECKLIST.md` lists all human-only steps.
- [ ] `docs/STATE.md` final update: what exists, known gaps, suggested next
      phases (invoicing/shipping integrations, analytics, nurture sequences).
- [ ] All work committed.
