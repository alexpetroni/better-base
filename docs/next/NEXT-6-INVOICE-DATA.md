# NEXT-6 — Invoices, part 1: the fiscal record (numbering, snapshot, VAT)

Context: `LAUNCH-CHECKLIST.md` § Legal ("current build does NOT issue invoices"),
`docs/STATE.md` § "Known gaps" (invoicing named the most likely next phase). Depends on
NEXT-3 (company/invoice settings) and NEXT-5 (event ledger, order events).

## Problem

A paid order produces no invoice. In Romania an invoice is a legal document with hard
requirements: a gapless number within a declared series, the issuer's full identification,
the buyer's details, per-line VAT, and immutability — a mistake is corrected by issuing a
storno (reversal) document, never by editing. Nothing in the schema or the code expresses
any of that, and the accountant's interim process is currently the only thing standing in.

This phase builds the **record**; NEXT-7 builds the document (PDF/XML) and delivery. Keep
them separate: the fiscal data model is where correctness lives, and it must be provable
without any rendering in the way.

## Deliverables

1. **`modules/invoice`** (module layout as everywhere else) with an append-only
   `invoices` table + `invoice_lines`, storing a **complete snapshot at issue time**:
   - issuer: legal name, CUI/VAT id, VAT-registered flag, Reg. Com., address — copied from
     settings, NOT referenced, so later settings edits cannot rewrite history;
   - buyer: name, email, address, and optional company fields (CUI/Reg. Com.) for a B2B
     buyer — a `company` capture step on checkout is in scope only insofar as the fields
     exist and flow through;
   - `series`, `number` (integer), the composed display number, issue date, due date,
     currency, per-line description/qty/unit price in bani/VAT rate in basis points, and
     the computed net / VAT / gross totals in bani;
   - link to the order (nullable — a manual invoice is possible later), and to the
     invoice it storns (`storno_of_invoice_id`).
2. **Gapless, race-free numbering.** The number comes from the series row under a
   transactional lock (`SELECT … FOR UPDATE` or an equivalent guaranteed sequence), so two
   concurrent issuances can never produce a duplicate or a gap. This is the single most
   important correctness property in the phase — test it by actually racing.
3. **VAT math in integer bani**, with the rounding rule chosen, documented in the module
   README, and tested at the boundaries (per-line rounding vs total rounding — pick the one
   Romanian practice expects and say why). Support the VAT-unregistered case
   (`neplătitor de TVA`: 0% lines plus the required mention) since that is a real state for
   a young business — driven by the `company.vatRegistered` setting.
4. **Issuance is idempotent and automatic**: a paid order gets exactly one invoice, issued
   through the NEXT-5 ledger/event path so a webhook redelivery cannot double-issue.
   Issuance failure must not lose the order — record the failure, surface it in the admin
   work queue, and make retry a one-click action.
5. **Storno on refund**: a refunded order issues a reversal document referencing the
   original, with negated amounts and its own number in the series. The original is never
   touched.
6. **Immutability enforced at the DB level** where possible (trigger or constraint) and at
   the service level always: no UPDATE, no DELETE of an issued invoice. A test must try and
   fail.
7. **GDPR interaction, decided and implemented**: accounting records are legally retained
   (state the retention period you implement and the basis in the module README), so
   `pnpm subscriber:delete` / the erase path must anonymize the customer's *account and
   marketing* data while leaving invoices intact. Update the gdpr module and its docs so
   the two rules do not silently contradict each other.

## Tests

- **Race test**: N concurrent issuances against the test DB produce N invoices with
  consecutive numbers, no duplicates, no gaps. Must fail against a naive `MAX(number)+1`.
- Unit: VAT math table — several line/qty/price/rate combinations incl. odd bani, the
  0%-unregistered case, and a total that would differ under the other rounding rule.
- Integration: a paid order issues exactly one invoice; redelivered webhook issues none.
- Integration: refund issues a storno referencing the original; original bytes unchanged.
- Integration: UPDATE/DELETE on an issued invoice is rejected.
- Integration: erase anonymizes the subscriber/order contact data and leaves the invoice
  snapshot readable.
- Integration: issuance failure is recorded and the retry action succeeds afterwards.

## Definition of Done

- [ ] Gate green; `pnpm db:migrate` clean on a fresh AND on a populated database.
- [ ] Numbering proven gapless under real concurrency (not by comment).
- [ ] Immutability + storno + idempotent issuance all proven by tests.
- [ ] GDPR erasure vs. accounting retention resolved, implemented, and documented.
- [ ] `LAUNCH-CHECKLIST.md` VAT/invoicing box updated to reflect what the app now does.
- [ ] STATE.md updated; work committed.
