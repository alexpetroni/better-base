# FIX-8 — Frontend a11y / SEO / performance batch

Audit ref: Frontend section (items 1–15). See `docs/AUDIT-2026-07-09.md`.

## Problem

The axe gate is static-only and misses behavioral/dynamic issues. Concrete gaps: chat
streaming isn't announced to screen readers, the home page has no real SEO metadata, PII
quiz-result pages are indexable, `srcset` is DPR-only so retina over-fetches, the sitemap
omits products/pages, no `hreflang`, chat scroll/error UX problems, double-submit on
public forms, and a date-formatting SSR/client timezone mismatch.

## Deliverables (grouped)

**Accessibility**
1. Chat message list gets `role="log" aria-live="polite" aria-atomic="false"` (+ optional
   `aria-busy`) so streamed replies are announced (`ChatPanel.svelte:82-100`).
2. Chat input gets a real (sr-only) label; on widget open, move focus into the input and
   support `Escape` to close (`ChatPanel.svelte:107-115`, `ChatWidget.svelte:30`).
3. Fix the auto-scroll hijack: only pin to bottom when already near the bottom
   (`ChatPanel.svelte:19-22`).
4. Replace the hardcoded RO `aria-label="Linkuri legale"` with a Paraglide message
   (`(public)/+layout.svelte:57`).

**SEO**
5. Home page uses the `<Seo>` component (title + description + canonical + OG)
   (`(public)/+page.svelte:8`).
6. Quiz result pages get `<meta name="robots" content="noindex">` (PII).
7. Sitemap includes published products and CMS pages (`sitemap.xml/+server.ts:15`).
8. Emit proper `<link rel="alternate" hreflang="ro|en|x-default">` per page instead of the
   display:none locale-link hack.

**Performance / correctness**
9. `buildSrcset` emits width-descriptor srcsets (`480w,768w,1200w…`) and `<Img>` honors
   the `sizes` prop (`imgproxy.ts:68-70`, `Img.svelte`), so covers stop over-fetching;
   OR drop the dead `sizes` prop if fixed sizing is intended (prefer the former for covers).
10. Pin `timeZone: 'Europe/Bucharest'` in date formatting (via the shared `formatDate`
    helper from FIX-7) to kill the SSR/hydration day-boundary mismatch.
11. Disable submit buttons during submission on public forms (cart add/remove/qty/checkout,
    newsletter, quiz-email) and admin login, to prevent double-submit.
12. Chat mid-stream error: mark the partial assistant message as failed with a retry
    affordance (or drop the incomplete bubble) instead of leaving a truncated reply.
13. Ensure the cookie banner and chat widget don't overlap/occlude on mobile
    (z-index/offset).
14. `<Img>` sets a height (or aspect-ratio) for SVG/dimensionless media to avoid CLS.

## Tests

- Extend the playwright a11y/e2e suite to cover the BEHAVIORAL gaps the static axe pass
  missed: chat reply is in an `aria-live` region; focus moves into the chat input on open
  and `Escape` closes; quiz result page has `noindex`; submit buttons disable during
  submission (assert disabled state on click).
- Unit: `buildSrcset` emits width descriptors; `formatDate` is timezone-stable (same output
  regardless of `process.env.TZ`); sitemap includes a seeded product and page.

## Definition of Done

- [ ] Gate green; extended e2e (behavioral a11y + double-submit + noindex) green for BOTH
      `SITE_ID`s.
- [ ] Home SEO present; result pages noindex; sitemap complete; hreflang emitted.
- [ ] Retina over-fetch fixed; date formatting timezone-stable; chat a11y + error UX fixed.
- [ ] STATE.md updated; work committed.
