# modules/invoice

The fiscal record (NEXT-6): append-only invoices with gapless numbering, full
snapshots and storno reversals. This module owns the DATA; rendering the
document (PDF/XML) and delivering it is NEXT-7's job and must need nothing
beyond what is stored here.

## The record is a snapshot, never a reference

An invoice row copies the issuer identification (from `site_settings`) and the
buyer details (from the order) AT ISSUE TIME. Editing settings, anonymizing an
order (GDPR) or renaming a product later can never rewrite an issued document.
Everything brand-/company-specific on an invoice is data from settings — no
legal identity is hardcoded anywhere in this module.

## Append-only, corrections by storno

An issued invoice is never UPDATEd and never DELETEd:

- **DB level**: `BEFORE UPDATE OR DELETE` triggers on `invoices` and
  `invoice_lines` raise an exception (migration `0016`). `TRUNCATE` is
  deliberately left possible — it is a table-maintenance operation used by the
  test harness, not a row mutation path any service performs.
- **Service level**: this module exposes no update or delete function, and the
  order FK has no cascade, so an invoiced order cannot be deleted either.

A mistake or a refund is corrected by a **storno**: a new document with its own
number in the same series, referencing the original via
`storno_of_invoice_id`, whose lines negate the original's STORED amounts
(negation, never recomputation — the reversal is exact by construction). One
storno per invoice, enforced by a unique index.

## Gapless, race-free numbering

`invoice_series` holds one row per declared series with the next number to
assign. Allocation (`allocateInvoiceNumber`) is an
`UPDATE … SET next_number = next_number + 1 … RETURNING` — the row lock the
UPDATE takes serializes concurrent issuances, and because allocation shares the
transaction of the invoice INSERT, a rollback returns the number instead of
leaving a gap. Two issuances can therefore never produce a duplicate or a gap
(`invoice.spec.ts` proves it by racing real connections; a unique index on
`(series, number)` backstops it). The series row is created on first use from
the `invoice.seriesPrefix` / `invoice.nextNumber` settings (so a series can
continue existing off-app numbering); from then on the ROW is the sole
authority — editing `invoice.nextNumber` later does not renumber anything.

## VAT math (integer bani)

Catalog prices are consumer prices and INCLUDE VAT — that is the amount Stripe
charged, and the invoice total must equal what was paid. So VAT is EXTRACTED
from the gross: `vat = gross · r / (10000 + r)` for a rate of `r` basis points
(`invoice.vatRateBp`), **rounded half-up to the ban, per line**; invoice totals
are plain sums of the lines. Per-line rounding is the rule Romanian practice
expects: Ordinul 2634/2015 requires the per-line VAT amount on the document,
and per-line rounding keeps every printed line and the totals consistent with
each other (rounding once on the total can disagree with the sum of the printed
lines by a ban — `vat.spec.ts` pins such a case). All math is integer-only; no
float ever touches an amount.

**VAT-unregistered issuer** (`neplătitor de TVA`, `company.vatRegistered`
off): lines carry rate 0 and zero VAT, and the invoice snapshot includes the
`invoice.vatUnregisteredMention` setting (default „Neplătitor de TVA”) in its
`mentions` — a real state for a young SRL, and reversible the day the entity
registers, without touching code.

## Issuance flow

- **Automatic**: the Stripe webhook issues the invoice INSIDE the same
  ledger-guarded transaction that creates the order
  (`checkout.session.completed` → `issueInvoiceForOrderInTx`), so a redelivery
  cannot double-issue: the `processed_events` claim skips the whole effect, the
  unique `(order_id) WHERE kind = 'invoice'` index backstops it. A refund
  (`charge.refunded`) issues the storno the same way.
- **Failure never loses the order**: incomplete issuer settings (unset or
  seeded placeholders — see `REQUIRED_ISSUER_SETTINGS`) make issuance fail
  WITHOUT failing the order; the failure is recorded on the order's event trail
  (`invoice-failed` / `storno-failed`) and surfaced in the admin work queue
  (`/admin/orders?f=invoice-missing` + badge).
- **Retry is one click**: the admin order detail's issue action calls
  `ensureInvoicesForOrder`, which locks the order row and issues whatever is
  missing (invoice, plus storno for a refunded order). Safe to race with a
  webhook redelivery — the order-row lock serializes them.

## GDPR vs. accounting retention

Invoices are financial-accounting documents; Romania requires keeping them —
Legea contabilității 82/1991 art. 25 (as amended by Legea 36/2023) sets a
**5-year retention period** (from 1 January following the financial year), and
this app implements **no automated deletion at all**: retention/disposal after
the legal period is an operator decision outside the app. Storing the buyer's
name/address/email on the invoice for that period is lawful under GDPR art.
6(1)(c), and art. 17(3)(b) exempts these records from the right to erasure.

`pnpm subscriber:delete` (modules/gdpr) therefore anonymizes the customer's
ACCOUNT and MARKETING data — subscriber row, order contact/shipping/company
fields, email log — and leaves `invoices`/`invoice_lines` untouched (it could
not modify them anyway: the DB triggers forbid it). The erase summary reports
how many invoices were retained so the operator can answer a data-subject
request precisely.
