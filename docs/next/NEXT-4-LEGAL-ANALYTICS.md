# NEXT-4 — RO legal surface + consent-gated analytics

Context: `LAUNCH-CHECKLIST.md` § Legal, `docs/STATE.md` § "Known gaps" (Analytics),
`modules/gdpr/consent.ts` + `CookieConsent.svelte`. Depends on NEXT-3.

## Problem

Two launch blockers that are code, not lawyering:

- **Romanian e-commerce law requires** the trader's identification (name, CUI, Reg. Com.,
  registered address, contact) to be visible on the site, and links to ANPC SAL and the EU
  SOL platform. None of that is rendered anywhere today.
- **Analytics ship nothing.** `analyticsAllowed()` exists as a documented hook point with a
  passing test and no consumer, and the cookie-policy copy that must describe the analytics
  cookie does not exist either. Whatever lands must load ONLY on consent — that is the
  whole reason the hook point was left.

(The lawyer review of privacy policy / T&C copy stays a human checklist item. Your job is
that the pages, fields and links exist and are wired to settings.)

## Deliverables

1. **Footer legal block** rendered from NEXT-3 settings on every page of both sites:
   company legal name, CUI (with the RO VAT prefix when VAT-registered), Reg. Com. number,
   registered address, contact email/phone, plus ANPC SAL and SOL links (the two ANPC
   links must carry the official destinations from settings and `rel="noopener"`).
   No literal company string anywhere in a component.
2. **Legal pages get the same identification block** — the seeded
   `/pagini/politica-de-confidentialitate` and `/pagini/termeni-si-conditii` render the
   operator/company data from settings rather than expecting the operator to paste it into
   the markdown body (which would drift). Keep the lawyer-editable prose in `/admin/pages`.
3. **A cookie policy page** (seeded, editable in `/admin/pages`) that enumerates the
   cookies the app actually sets: session/auth, `cart`, consent cookie, chat session
   cookie, and the analytics cookie added below — each with purpose and lifetime. Link it
   from the consent banner and the footer. If the enumeration can be derived from code
   rather than duplicated by hand, do that; otherwise add a test that fails when a new
   cookie name appears in the codebase without a policy entry.
4. **Analytics behind an interface + mock**, matching `ChatProvider`/`StripeGateway`:
   - `AnalyticsProvider` seam with a no-op default; a privacy-friendly, cookieless-capable
     provider (Plausible or Umami — self-hostable, GDPR-friendly, no consent needed in
     their cookieless mode) selected only when its env config is present.
   - The script is injected **only** when `analyticsAllowed(decision)` is true, evaluated
     on the client after the consent decision — and it must be removed/never-loaded when
     consent is withdrawn (revocation is a real GDPR requirement, not just first-visit).
   - No page-view tracking of admin routes; no PII in event payloads (assert it).
   - `PUBLIC_*` env only for anything the client reads.
5. **Consent revocation path**: the banner/settings link lets a visitor change a previous
   decision, and doing so drops the analytics cookie(s) the provider set.

## Tests

- Unit: footer block renders every required field from settings; missing optional fields
  degrade cleanly; nothing renders a hardcoded company string (grep-style assertion).
- Unit/integration: ANPC + SOL links present on every page layout, with the URLs from
  settings.
- Unit: analytics provider selection — no env ⇒ no-op provider; env present ⇒ real
  provider; the real provider is never selected in tests.
- Component: with consent `null` or `denied`, no analytics script tag and no analytics
  cookie; with `granted`, exactly one script tag; on revocation the tag is gone after
  reload and the cookie is cleared.
- Unit: admin routes are excluded from tracking; event payloads carry no email/user id.
- Cookie-inventory test (per deliverable 3).
- E2E: first visit → banner → refuse → no analytics request; accept → analytics request
  fires once; revoke from the cookie-policy page → no further requests.

## Definition of Done

- [ ] Gate green.
- [ ] Footer + legal pages carry company identification and ANPC/SOL links on both sites,
      sourced from settings.
- [ ] Cookie policy page exists, is linked, and lists every cookie the app sets.
- [ ] Analytics load only on granted consent, and stop on revocation — proven by e2e.
- [ ] `LAUNCH-CHECKLIST.md` Legal section updated: the boxes this phase makes mechanical
      (identification, ANPC/SOL) become "fill in `/admin/settings`", and the ones still
      needing a lawyer stay explicit.
- [ ] STATE.md updated; work committed.
