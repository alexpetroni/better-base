# FIX-7 — Module boundaries + simplification (Theme G + duplication)

Audit refs: Theme G (architecture #1), architecture #3/#4/#5, simplification #1–#10. See
`docs/AUDIT-2026-07-09.md`. This is a QUALITY phase — no behavior change; the full test
suite must stay green throughout.

## Problem

The module-boundary ESLint rule only matches the `$lib/modules/*` alias, so modules import
each other's internals by relative path freely (a mesh, not a star). Significant
duplication: slug helpers ×3, pillar validate/replace ×2, `Result` envelope ×7, route
form-action boilerplate, date formatting ×9, fixed-window logic (done in FIX-1). Shared
utils (`slug.ts`, `money.ts`) trapped in feature modules. Hidden import-order-dependent
global (`registerMediaReferenceCheck`). Dead code.

## Deliverables

1. **Decide and enforce the boundary policy**: either (a) extend ESLint (e.g.
   `eslint-plugin-boundaries` or a `no-restricted-imports` pattern catching relative
   `../<other-module>/` imports) so cross-module access must go through barrels, then fix
   the violating imports to use barrels; OR (b) if some cross-module coupling is
   legitimate (shared schema for FK relations), codify exactly what's allowed and document
   it in STATE.md. Cross-module **schema** imports for FK relations may be permitted; the
   avoidable **service/logic** imports should route through barrels. Make the rule and
   reality match.
2. **Promote shared utilities** out of feature modules: move `slug.ts` and `money.ts`
   (and the shared `Result<T,E>` envelope, `normalizeEmail`/email regex, `isRecord`) to a
   shared `$lib/util` (or leaf modules with no schema). Update imports.
3. **Collapse duplication**:
   - one generic `ensureUniqueSlug(db, table, cols, base, fallback, excludeId)`.
   - shared `setPillars`/`pillarSlugsFor` for the many-to-many join replace + read.
   - one generic `Result<T,E>`; each module keeps only its error union.
   - route helpers: `formStr`, `failResult`, `resolveSitePillars`, `parseListFilter`, and
     a `createEntityAction` factory to kill the repeated create/list/error boilerplate.
   - shared `formatDate(d, style)` helper (also pins timezone — see FIX-8).
   - extract `<CoverField>` and `<PillarChecklist>` shared Svelte components used by the
     article/product/quiz editors.
4. **Fix the hidden global**: replace the import-side-effect `registerMediaReferenceCheck`
   array (`media/service.ts:34`) with explicit injection of the check list via `MediaDeps`
   where `deleteMedia` is wired, so media-delete protection can't be silently disabled by
   tree-shaking/import-order.
5. **Delete dead code**: `isPurchasable`, unused `media/server.ts` raw re-exports,
   `createImgUrl`, unused const re-exports, and the public unguarded `/dev/form` demo page.
   Verify each is truly unreferenced before deleting.

## Tests

- The existing full unit + e2e suite must remain green (this is the primary safety net for
  a no-behavior-change phase).
- ESLint must pass AND actually catch a deliberately-added cross-module internal import
  (add a temporary violating import in a throwaway test fixture to prove enforcement, then
  remove it) — or, if policy (b), a doc note explaining the allowed set.
- Add/keep unit tests for the extracted shared helpers (slug, setPillars, Result usage,
  formatDate).

## Definition of Done

- [ ] Gate green; e2e green; no behavior change (diff is refactor-only).
- [ ] Boundary rule and code agree and are enforced (or the allowed coupling is codified).
- [ ] Duplication collapsed per above; dead code removed; hidden global eliminated.
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
