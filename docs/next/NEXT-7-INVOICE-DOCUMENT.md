# NEXT-7 — Invoices, part 2: PDF, e-Factura XML, delivery, admin

Depends on NEXT-6 (the fiscal record) and NEXT-3 (settings). Serverless constraint from the
entry file applies hard here: **no runtime filesystem writes** — rendered documents go to
the S3 bucket, exactly like media originals.

## Problem

The invoice record from NEXT-6 is not something a customer or an accountant can hold. They
need a PDF, and — because Romania's e-Factura (RO_CIUS / UBL 2.1) reporting obligation now
reaches B2C as well — a structured XML representation. Actual submission to ANAF's SPV
needs a qualified certificate and an OAuth enrollment that only a human can complete, so
this phase produces the artifact and the seam, not the submission.

## Deliverables

1. **PDF renderer** for an invoice snapshot, pure and deterministic: same invoice in ⇒
   byte-comparable PDF out (no embedded timestamps/ids that change per run — pin them).
   Requirements: Romanian diacritics render correctly (choose a library + embedded
   open-licensed font and commit the font with its licence file; state the choice and the
   size cost in the module README), all legally required fields present, the
   VAT-unregistered mention when applicable, storno documents clearly marked.
   It must run on Node 22 in a Vercel function — no native binaries, no headless browser.
2. **Storage + retrieval**: rendered documents are written once to the S3 bucket under a
   dedicated prefix (never the public media prefix), retrieved through a **signed,
   short-lived, authenticated** route. Customer access is limited to their own invoice via
   the order's success/lookup path; admin access is unrestricted. An unauthenticated or
   cross-customer request gets 403/404 — test it, this is the classic leak.
3. **e-Factura XML** (UBL 2.1, RO_CIUS profile) generated from the same snapshot, stored
   alongside the PDF, and validated in tests against the schema/rules you can check
   offline. Provide the `EFacturaSubmitter` seam with a no-op default and document exactly
   what a human must do to enable real ANAF submission (certificate, SPV enrollment,
   the env vars) in `DEPLOYMENT.md` + `LAUNCH-CHECKLIST.md`. Do not fake a submission.
4. **Email delivery**: the order-confirmation email gains the invoice as an attachment (or
   a signed link if the attachment path proves unreliable — decide and document), sent
   through `modules/email` with an idempotency key derived from the invoice id, honoring
   `EMAIL_DRYRUN`. Resend attachment support has to be added to the email module — keep the
   typed-template pattern intact.
5. **Admin**: `/admin/orders/[id]` shows the invoice (number, totals, status) with download
   links for PDF and XML, a re-send-email action, and the storno action wired to NEXT-6.
   A "download all invoices for a month" export for the accountant, as a zip or a CSV +
   files — pick the shape the accountant can actually use and say why.
6. **Customer access**: the order success page and the confirmation email give the buyer a
   durable way back to their invoice that does not require an account.

## Tests

- Unit: renderer determinism — the same invoice renders identical bytes twice.
- Unit: rendered PDF text layer contains every legally required field (extract text and
  assert), diacritics survive round-trip, storno marked, 0%-VAT mention present when the
  issuer is unregistered.
- Unit: UBL XML validates and carries the same totals as the record (property-style test
  over several invoices — the XML and PDF must never disagree with the snapshot).
- Integration: document written to storage once; a second render does not duplicate.
- Integration: retrieval authorization — owner ok, other customer 403/404, anonymous
  403/404, admin ok, expired signature rejected.
- Integration: confirmation email carries the attachment in dry-run capture; re-send is
  idempotent under the same key.
- E2E: mock-Stripe purchase → success page → invoice downloadable; admin sees it in the
  order detail.

## Definition of Done

- [ ] Gate green; e2e green.
- [ ] A purchase end-to-end (mock gateway) yields a stored, downloadable, legally complete
      PDF plus a valid RO_CIUS XML, and an email carrying it.
- [ ] No runtime filesystem writes anywhere in the path (assert on the code, and confirm
      with `DEPLOY_TARGET=vercel pnpm build`).
- [ ] Cross-customer and anonymous access to a document is impossible.
- [ ] ANAF submission seam documented with the exact human enrollment steps; no faked
      submission.
- [ ] STATE.md, DEPLOYMENT.md, LAUNCH-CHECKLIST.md updated; work committed.
