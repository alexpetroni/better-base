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
`storno_of_invoice_id`. A **full** storno's lines negate the original's STORED
amounts (negation, never recomputation — the reversal is exact by
construction). A **partial** storno (FIX-10: a partial Stripe refund) reverses
an AMOUNT, not lines: one negative line at the original rate, VAT extracted
from the refunded gross with the same half-up rule (`partialStornoLineAmounts`).
Several stornos may therefore reference one invoice; the rule that matters —
**Σ storno gross ≤ original gross** — is checked by the service under the
original's row lock and enforced at the DB level by the `invoices_storno_bounded`
`BEFORE INSERT` trigger (migration 0022). "Reverse the rest"
(`issueStornoForOrderInTx` without an amount) is idempotent: once fully
reversed it returns the latest storno instead of issuing another.

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
  unique `(order_id) WHERE kind = 'invoice'` index backstops it. A FULL
  refund (`charge.refunded` with `amount_refunded == amount`) issues the
  storno the same way — of the whole invoice, or of the remainder if partial
  stornos were issued before. A PARTIAL refund issues NO storno automatically:
  the operator reviews the order and clicks "storno parțial"
  (`issuePartialStornoForOrder`), which reverses exactly
  `orders.refunded_cents − Σ stornos` — the document follows the money
  Stripe recorded, no amount is typed.
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

## The documents (NEXT-7): PDF + e-Factura XML

Both documents render from the SAME stored snapshot (`model.ts` →
`InvoiceDocumentModel`) and nothing else, so they can never disagree with the
record or with each other. Both renderers are **deterministic**: the same
snapshot produces byte-identical output on every run (pdf-lib's per-run
stamps — creation/modification date, producer — are pinned to the invoice's
own fields; the XML is plain string building). Dates on documents are
formatted in **Europe/Bucharest** (`invoiceDateIso`/`invoiceDateRo`): an
invoice issued 00:30 EET must not carry yesterday's (UTC) date.

### PDF (`pdf.ts`)

- **Library: pdf-lib + @pdf-lib/fontkit** — pure JS, no native binaries, no
  headless browser; runs identically in vitest, node scripts and a Node 22
  Vercel function (the serverless constraint that ruled out wkhtmltopdf/
  Puppeteer-class renderers).
- **Font: DejaVu Sans** (`fonts/DejaVuSans.ttf`, Bitstream Vera license +
  public-domain extensions — committed alongside as `fonts/LICENSE`), chosen
  for correct comma-below Romanian diacritics (Ș ș Ț ț) with a permissive,
  vendorable license. **Size cost**: 739 KB TTF committed twice (the file and
  its generated base64 module `fonts/dejavu-sans.ts`, regenerated via
  `node scripts/embed-font.ts`); at render time the font is SUBSET into the
  document, so a typical invoice PDF is **~12 KB**, fine as an email
  attachment. The base64-module embedding (rather than a runtime file read)
  keeps the renderer free of filesystem access and bundler-proof.
- The text layer carries every legally required field (Codul fiscal art.
  319(20)): series+number, issue date, both parties' identification (CUI,
  Reg. Com., addresses), per-line qty / unit net price (4 decimals) / net /
  VAT rate / VAT / gross, document totals, the `neplătitor de TVA` mention
  when applicable, and a storno is marked `FACTURĂ STORNO` with a reference
  to the document it reverses — `pdf.spec.ts` extracts the text and asserts.

### e-Factura XML (`efactura.ts`, `efactura-validate.ts`)

UBL 2.1 Invoice constrained by **CIUS-RO 1.0.1** (CustomizationID
`urn:cen.eu:en16931:2017#…CIUS-RO:1.0.1`). A storno is what RO practice
submits: **InvoiceTypeCode 380 with negative quantities/amounts** plus a
`BillingReference` to the original — not a 381 credit note. The VAT
categories are `S` (standard), `Z` (zero-rated) and `O` for the
`neplătitor de TVA` issuer (no percent, exemption reason from the
snapshotted mention, no supplier VAT identifier — the BR-O rules).

**Rounding note (BR-CO-17)**: the record's per-line half-up rounding means a
category's VAT can differ from `rate × taxable` recomputed on the subtotal by
up to one ban per line; the offline validator accepts exactly that tolerance,
and the XML totals ALWAYS equal the stored record (asserted per document in
tests — the record is the truth, EN 16931's recomputation is the
approximation).

**CIUS-RO status (FIX-12).** The snapshot stores structured addresses, so
both parties carry `StreetName`, `CityName`, `PostalZone`,
`CountrySubentity` (ISO 3166-2:RO, `RO-CJ`…) and `Country`; a București
address puts `SECTORn` in `CityName` under `RO-B` (the CIUS-RO rule). Under
category O the buyer party carries no `PartyTaxScheme` (BR-O-2) and the
exemption reason comes from its own snapshot column, never from a
payment-terms note. Multi-rate documents emit one `TaxSubtotal` per
(category, rate). `validateEFacturaXml` is an offline tripwire (structure,
namespaces, BR-CO arithmetic, BR-O rules, the address rules above, snapshot
agreement), NOT the official ANAF schematron. Two **golden fixtures** in
`apps/web/tests/fixtures/efactura/` (`factura-cluj.xml` — a județ B2C buyer;
`factura-bucuresti-sector-b2b.xml` — a București-sector B2B buyer) are
asserted byte-for-byte by `efactura.spec.ts`, so any renderer change is a
deliberate re-validation, never a drift. **They have NOT been run through
ANAF's public validator from this repository** (no live service is called
from the build); uploading both files to ANAF's e-Factura validator and
recording the result is a LAUNCH-CHECKLIST step, and the first real SPV
answers are the final acceptance.

**Submission tracking (FIX-12).** SPV transmission is mandatory (B2B since
2024, B2C since 2025-01-01) within **5 calendar days** of issuance, so it is
tracked, not hoped for: every invoice and storno gets an
`invoice_submissions` row (`pending`) in the issuing transaction
(`submissions.ts`). `GET /api/cron/efactura-submit` drains due rows —
`FOR UPDATE SKIP LOCKED` claim with a 15-minute lease, so two overlapping
ticks never share a row — renders the XML into the fiscal bucket and hands
it to the `EFacturaSubmitter` seam (`efactura-submitter.ts`): `submitted`
is terminal with ANAF's index; a thrown submission is retried with doubling
backoff (15 min, 6 h cap) and PARKED as `failed` after 5 attempts; the
default no-op submitter answers `skipped`, which is not an attempt — the
row stays pending, deferred an hour, and the XML is already stored for the
manual SPV upload. Asking for the real submitter before implementing it
(`ANAF_EFACTURA_ENABLED`) is a hard boot error — nothing ever fakes a
submission. `/admin/orders` → "De trimis la ANAF" lists every order with an
unsubmitted document and the calendar days left (negative = overdue). A
download (customer or staff) only renders and stores; it never submits.

## Storage, retrieval, delivery

- **Private, versioned storage** (`documents.ts`, FIX-12): rendered
  documents go to the **fiscal bucket** (`S3_INVOICE_BUCKET`, default
  `<S3_BUCKET>-fiscal`; `getInvoiceStorage()`), never the media bucket —
  under the default image provider that one is bound to a public domain and
  R2 public access is not prefix-scoped (audit P0 #4). Keys are
  `invoices/<invoiceId>.<rendererVersion>.<pdf|xml>`
  (`INVOICE_PDF_RENDERER_VERSION`, `EFACTURA_RENDERER_VERSION`): a renderer
  fix bumps the version and re-renders instead of freezing a defective file,
  while the earlier file stays as the record of what was delivered.
  Documents render on first request (download, email, export, or the
  submission cron); determinism makes the write-once rule race-proof.
  `pnpm storage:fiscal-migrate` moves whatever a pre-FIX-12 deploy wrote
  under `invoices/` in the media bucket; `launch:check` proves the public
  media origin does not serve `invoices/`.
- **Retrieval** (`/api/invoices/[id]/[format]`): an admin session, or a
  signed short-lived token (`access.ts`, HMAC over invoice id + format +
  expiry under TOKEN_SECRET, TTL 15 min). Tokens are minted ONLY on the order
  success/lookup page, which authenticates the buyer by the unguessable
  Stripe session id — the durable, no-account way back that the confirmation
  email links to. Anonymous/cross-customer/expired ⇒ 403; unknown ⇒ 404.
- **Email**: the order-confirmation email attaches the invoice PDF (the
  attachment path — bytes are small and self-contained; a link-only fallback
  was not needed) and carries the durable order link; the admin detail page
  has a re-send action (`invoice-email` template) idempotency-keyed on
  (invoice id, page nonce). All sends honor `EMAIL_DRYRUN`.
- **Accountant export** (`/admin/orders/export?month=YYYY-MM`): one zip per
  month — `facturi.csv` (semicolon-separated, comma decimals, UTF-8 BOM:
  what a Romanian-locale Excel import expects; one `baza_<rate>`/`tva_<rate>`
  column pair per VAT rate present in the month; every text cell through the
  shared `util/csv.ts`, which neutralises formula injection from
  customer-entered names) plus every document as PDF and XML, because
  bookkeeping consumes exactly that: a journal-entry index plus the
  justifying documents. The month is the Romanian calendar month, selected
  in SQL on `issued_at`.
