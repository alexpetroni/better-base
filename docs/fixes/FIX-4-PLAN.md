# FIX-4 — Schema-safe content bundle (Theme D)

Audit ref: Theme D (architecture #2, data-model HIGH-1, MED-2, MED-3). See
`docs/AUDIT-2026-07-09.md`. This is the highest-value fix — export/import is the whole
point of the two-DB design and it silently drops columns today.

## Problem

`content/bundle.ts:25-83` hand-redeclares `ArticleContent`/`QuizContent`/`ProductContent`/
`MediaDescriptor` as parallel copies of the Drizzle row types, with hand-written mappers
in `export.ts`/`import.ts` — 4 places, no compiler link. Already broken: `media.blurhash`
(`media/schema.ts:26`) is omitted, so every imported image loses its placeholder. Adding
any column silently diverges content between sites. Also: import with no matching pillars
creates an invisible (untagged) item with only a stderr warning + zero exit; re-import
never refreshes changed bytes and orphans media.

## Deliverables

1. Derive the bundle content/descriptor types from the Drizzle row types
   (`typeof table.$inferSelect`) via explicit `Pick`/`Omit` (drop only id/site-local
   fields), so adding a column fails to compile until the bundle mapper is updated.
2. Add `blurhash` (and any other currently-missing column found) to the media descriptor,
   export mapper, and import insert.
3. Add a **round-trip parity test per content type** asserting every persisted column is
   represented in the bundle (e.g. compare `Object.keys($inferSelect sample)` minus the
   known-excluded set against the descriptor keys) so future drift is caught automatically.
4. Import robustness: if ALL of an item's pillar slugs are missing in the target DB, make
   it a hard failure (non-zero exit) unless an explicit `--allow-untagged` flag is passed;
   surface skipped-pillar warnings clearly.
5. Document the media key-immutability assumption; either sweep orphaned media on
   re-import or explicitly document the accepted leak.

## Tests

- **Round-trip parity test** per type — fails today for media (blurhash) and would fail if
  any column is added without updating the bundle.
- Integration (two test DBs): export an article + quiz + product (with media bytes) from
  DB A, import into DB B, assert every field including blurhash round-trips; re-import is
  idempotent (no dupes); import of an item whose pillars are absent fails (or is skipped
  with `--allow-untagged`) rather than creating an invisible item.

## Definition of Done

- [ ] Gate green; parity test passes and demonstrably fails if a column is added or
      blurhash removed.
- [ ] Bundle types are schema-derived; blurhash round-trips; missing-pillar import is a
      hard failure by default.
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
