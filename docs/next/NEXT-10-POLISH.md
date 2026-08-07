# NEXT-10 — Close the remaining gaps: chat history, blurhash, launch dry run

Context: `docs/STATE.md` § "Known gaps" (chat history restore, media blurhash) and
`LAUNCH-CHECKLIST.md` § "Final smoke". This is the last phase of the batch; it closes the
two remaining named gaps and turns the checklist into something rehearsable.

## Problem

Three leftovers, each small on its own:

- **Chat history is client-local.** The widget's message list lives in the browser; the
  cookie only carries session identity. A reload loses the conversation even though the
  messages are stored server-side — the documented fix (a GET on `/api/chat` after
  `verifySessionToken`) was never built.
- **`media.blurhash` exists and is never populated.** Every media row carries a column that
  is always null, so the CLS work from FIX-8 has no placeholder to use.
- **The launch checklist has never been rehearsed.** Nobody has walked DEPLOYMENT.md §11
  end-to-end against a build with invoices, shipping and analytics in it, so nobody knows
  which of its steps are now wrong.

## Deliverables

1. **`GET /api/chat`** returning the stored messages for the session after
   `verifySessionToken`, with the widget restoring them on mount: correct order, no
   duplication against locally-held messages, bounded count, and the same rate-limit and
   retention rules the POST path already obeys. An invalid, expired or foreign token gets
   nothing — the token is the only authorization, so test that hard.
2. **Blurhash populated at upload/confirm time**, computed server-side from the uploaded
   bytes (a small pure-JS encoder; decode at a tiny size — this must be cheap enough to run
   inside a serverless request, and if it is not, move it to the cron seam and say so).
   Backfill script for existing rows (`pnpm media:blurhash`), idempotent and resumable.
   Wire the value into `<Img>` as the placeholder so it actually reduces CLS; if a row has
   no blurhash the current behavior must be unchanged.
3. **Launch dry run**: walk `DEPLOYMENT.md` §11 + `LAUNCH-CHECKLIST.md` against the local
   stack with the full feature set (`pnpm launch:check`, migrate, seed, `content:init`,
   both `SITE_ID`s, a mock purchase producing an invoice and an AWB, a consent-gated
   analytics load, a cron invocation of each scheduled route). Fix every step that is now
   wrong or missing; the deliverable is the corrected documents plus a
   `docs/LAUNCH-DRY-RUN.md` recording what was executed and what came out.
4. **A final honest gap list** at the end of `docs/STATE.md`: what this batch did NOT do,
   what remains human-only (lawyer review, accounts, DNS, live keys, real card purchase,
   ANAF enrollment, courier contract), and any deliberate deferral, each with a one-line
   reason. If something in this batch was blocked, it belongs here rather than in a
   BLOCKER.md nobody reads later.

## Tests

- Integration: history restore returns the session's messages in order for a valid token;
  returns nothing for an expired/invalid/foreign token; respects the bound.
- Component/e2e: reloading the page restores the visible conversation without duplicates.
- Integration: chat retention sweep still prunes the messages the restore path reads.
- Unit: blurhash encoder output is deterministic for a fixture image and decodes to the
  expected dimensions; a non-image or corrupt upload does not break confirm.
- Integration: upload → confirm populates `blurhash`; backfill script fills legacy rows and
  is safe to re-run.
- Component: `<Img>` renders the placeholder when a blurhash exists and is unchanged when
  it does not.
- The full suite green under BOTH `DB_DRIVER=pg` and `DB_DRIVER=neon` (`pnpm test:neon`),
  and `DEPLOY_TARGET=vercel pnpm build` green.

## Definition of Done

- [ ] Gate green; `pnpm test:neon` green; e2e green; both builds green.
- [ ] Chat history restores on reload; blurhash is populated for new and backfilled rows.
- [ ] `docs/LAUNCH-DRY-RUN.md` records an executed walk-through, and every step it proved
      wrong is fixed in `DEPLOYMENT.md` / `LAUNCH-CHECKLIST.md`.
- [ ] `docs/STATE.md` ends with an honest, current gap list for whoever picks this up next.
- [ ] Work committed.
