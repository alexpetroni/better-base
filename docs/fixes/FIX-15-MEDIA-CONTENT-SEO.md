# FIX-15 — Media, content and SEO: quarantine confirm, safe re-seed, visibility, locale truth

Audit refs: P1 "Media, content & blog" (all three); P1 hreflang; P2 quiz save validation,
scoring shape, `?page=`, media refs, bundle determinism, cache headers. See
`docs/AUDIT-2026-09-03.md`.

## Problem

SVG safety depends on object state the uploader can rewrite through a presigned PUT that
stays valid 10 minutes after confirm; import and seed never sanitize. `pnpm db:seed` and
`content:init` overwrite live data although DEPLOYMENT.md calls them safe to re-run. The
blog detail page ignores pillar activity, so de-pillared content stays indexable; quizzes
are missing from the sitemap. The paraglide strategy has no `url` entry, yet every page
advertises `hreflang="en"` alternates pointing at `/en/…` pages that render Romanian with
a canonical back to the base URL. A published quiz can be saved unrenderable; scoring
trusts the answer shape.

## Deliverables

1. **Quarantine confirm.** Presign into `pending/<ticket>` keys the public origin never
   serves (document the Cloudflare rule / MinIO policy); `confirmUpload` produces the served
   object — `CopyObject` with `MetadataDirective: REPLACE` and `Cache-Control: public,
   max-age=31536000, immutable` for rasters, sanitized `PutObject` + attachment disposition
   for SVGs — then deletes the pending object. `ensureMedia` (import) and the seed go through
   the same finalize step. Drop `style` from the SVG allowlist (or scrub `url(`/`@import`).
2. **Safe re-seed.** Demo articles/products/quiz become create-only (`onConflictDoNothing`,
   like `ensurePage`); `importContent` is create-only by default with `--overwrite`; scripts
   split into `seed:base` (idempotent, always safe) and `seed:demo`; DEPLOYMENT.md §12
   corrected. Import writes row + join rows in one transaction; export orders media by key
   and pillars by sort; `parseBundle` rejects unknown keys.
3. **Visibility + sitemap.** `getBySlug` takes `pillarSlugs` and applies the listing
   predicate; quiz result pages check the pillar too; published + active quizzes join the
   sitemap; `?page=` parsed with `Number.isSafeInteger` and clamped (404 past the end).
4. **Locale truth.** Decide per site config: `locales` drives BOTH paraglide's runtime
   strategy and the alternates. Implement the honest option now — emit `hreflang`
   alternates only when the site has more than one locale AND the `url` strategy is
   active; set `sleep`/`life` to `['ro']` until content is localized; update the e2e that
   asserts the `/en/` alternate (the audit explains why the old assertion was wrong).
   Keep `en.json` and the messages parity test.
5. **Quiz safety.** `updateQuiz` runs `validateForPublish` on the merged config when the
   quiz is published (reject with a form error); `validateFormSchema` checks question
   `type` against formcomp's `QuestionType`; scoring coerces by question type (arrays only
   for multi-select, numerics bounded with a default cap); `maxScore` counts only questions
   visible under the submitted answers (evaluate `condition`s server-side — export
   formcomp's pure evaluator via a subpath if needed; fixing the package is allowed, not a
   rewrite).
6. **Media refs.** Reference matching covers titled refs (`![a](media:ID "title")`) and quiz
   intros; the admin media library and picker are paginated and skip placeholder decoding
   for thumbnails.

## Tests

- **Integration (must FAIL on current code):** after confirm, a second PUT to the presigned
  URL does not change the served object (key differs / pending deleted); an imported SVG
  with a script is sanitized and served as attachment; rasters carry the cache header.
- Integration: re-running `seed:demo` after an admin edit leaves stock, price, status and
  body untouched; import without `--overwrite` skips existing slugs and reports them.
- Integration: an article whose only pillar is inactive returns 404 at `/blog/<slug>`;
  quizzes appear in the sitemap; `?page=1.5` → page 1, `?page=999` → 404.
- E2E: with a single-locale site no `hreflang` links are emitted and `/en/...` is not
  advertised; both sites still boot; messages parity holds.
- Unit: publish-state save rejects a bad question type; scoring rejects an array answer on
  single-select, caps numerics, and computes `maxScore` over visible questions.

## Definition of Done

- [ ] Gate green; the quarantine and re-seed regressions pass, each added in a test-first commit that precedes its fix in `git log`.
- [ ] `pnpm db:migrate` clean (if any schema change); storage layout documented.
- [ ] DEPLOYMENT.md §5/§6/§12 updated (pending prefix rule, seed commands, locale policy).
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
