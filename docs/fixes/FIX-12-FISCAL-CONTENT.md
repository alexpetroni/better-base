# FIX-12 — Fiscal content: VAT model, CUI, CIUS-RO addresses, submission tracking, private storage

Audit refs: P0 #4; P1 "Invoicing & e-Factura" (all six); P2 CSV hygiene, VAT category
holes, write-once renders. See `docs/AUDIT-2026-09-03.md` and
`apps/web/src/lib/modules/invoice/README.md`.

## Problem

The ledger (numbering, snapshot, immutability, storno arithmetic) is sound; the fiscal
content around it is not. One global VAT rate at issuance time (RO: 21% standard / 11%
reduced since 2025-08-01; no per-product rate; no effective dating). CUI has no checksum
and the issuer prefix is not reconciled with `company.vatRegistered`. The e-Factura XML
lacks `CountrySubentity` and `PostalZone`, puts the wrong value in `CityName`, ignores the
București sector rule and emits a buyer VAT id under category O — it will be rejected for
every Romanian address while the docs call it compliant. Mandatory SPV submission (5
calendar days) is untracked and the XML is rendered lazily on a customer GET. Share capital
(Legea 31/1990 art. 74) is absent. B2B invoices carry the parcel address. Fiscal documents
live under `invoices/` in the media bucket that the default provider binds to a public
domain.

## Deliverables

1. **VAT model.** `products.vat_rate_bp` (nullable → falls back to the setting), validated
   against an allowlist of RO rates; snapshotted onto `order_items` at checkout and copied
   to `invoice_lines`. The standard rate becomes an effective-dated list in the settings
   registry (`[{from: '2025-08-01', bp: 2100}, …]`, editable), selected by
   `order.createdAt`. Multi-rate invoices produce one `TaxSubtotal` per rate. Migration +
   backfill from the current setting.
2. **CUI.** `isValidCui()` (mod-11 checksum, key 753192753) in `util/cui.ts`; used by the
   B2B checkout form and the `company.cui` setting validator; snapshot stores
   `displayCui(cui, vatRegistered)` (prefix forced/stripped, uppercase);
   `missingIssuerSettings` reports a prefix/registration mismatch. Fix the spec fixtures to
   valid CUIs.
3. **Address model.** Structured issuer address settings (`company.street`, `city`,
   `county` as ISO 3166-2:RO code, `postalCode`) and structured buyer address in the
   snapshot (street, city, county code, postal code, country), mapped from Stripe's
   `shipping_details` (county name → code table; București → `SECTORn` in `CityName`).
   B2B: company address fields in the checkout form and snapshot; used as the buyer
   address when present. B2C buyer name prefers `customer_details.name`. Emit
   `CountrySubentity`, `PostalZone`, correct `CityName`; suppress buyer `PartyTaxScheme`
   under category O. Extend `validateEFacturaXml` with these rules and add one golden
   fixture that has been checked against ANAF's public validator (document the check in
   the README; if the validator is unreachable from the runner, deliver the fixture and
   record it as a LAUNCH-CHECKLIST step — never claim validation you did not run).
4. **Share capital.** `company.shareCapital` setting (launch-required for SRL/SA),
   `issuer_capital` snapshot column, printed under Reg. Com. on the PDF.
5. **Submission tracking.** `invoice_submissions` (invoice id, status pending/submitted/
   failed, submitted at, anaf index, error) written at issuance for every invoice and
   storno; a cron route (`/api/cron/efactura-submit`, `CRON_SECRET`-guarded, added to
   `vercel.json` and §9) renders + submits pending rows through the `EFacturaSubmitter`
   seam (mock in tests; the real adapter stays unimplemented and refuses at boot as today)
   with retry/park; `/admin/orders` filter "de trimis la ANAF" with days-remaining. Move the
   submitter call out of the customer GET. Correct DEPLOYMENT.md §7: the duty and deadline.
6. **Private storage.** `S3_INVOICE_BUCKET` (defaults to `S3_BUCKET` + `-fiscal` locally;
   required in `launch:check` when `IMAGE_PROVIDER=cloudflare`), never publicly bound;
   documents move there (existing keys migrated by a script, idempotent). `launch:check`
   probes that `${MEDIA_PUBLIC_BASE_URL}/invoices/` is not readable. Versioned document
   keys (`<id>.<rendererVersion>.<fmt>`) so a renderer fix re-renders instead of freezing a
   defective file; submission state lives in the table, not in object existence.
7. **Export hygiene.** UTF-8 BOM; `csvField` prefixes `= + - @ \t \r` with `'` and covers
   `displayNumber`; per-rate base/VAT columns; SQL month window in Europe/Bucharest.
   XML/PDF carry `OrderReference` and payment reference; a card-paid invoice sets
   `PrepaidAmount` = total, `PayableAmount` = 0, means code 48, and the PDF prints
   "Achitat cu cardul la <data>". Exemption reason gets its own snapshot column; a zero
   rate on a registered issuer is rejected by the settings validator.

## Tests

- Unit (must FAIL on current code): two products at 21% and 11% → two tax subtotals, integer
  totals reconcile; a retry issued after a rate change uses the order-date rate.
- Unit: CUI checksum matrix (valid/invalid/prefix cases); `displayCui` consistency rule.
- Unit: XML for a Cluj address and a București sector address passes the extended offline
  validator; category O emits no buyer VAT id; the golden fixture is byte-stable.
- Integration: issuance writes a `pending` submission; the cron submits through the mock,
  parks after N failures, is exactly-once under two concurrent ticks.
- Integration: documents land in the fiscal bucket; the media bucket has no `invoices/`
  object after the migration script; retrieval route unchanged for customers/staff.
- Unit: CSV formula prefixing, BOM, month window; PDF shows share capital and "achitat".

## Definition of Done

- [ ] Gate green; the VAT, CUI, XML-address and submission regressions pass, each added in a test-first commit that precedes its fix in `git log`.
- [ ] `pnpm db:migrate` clean on fresh and populated DBs (rate/backfill, address, capital,
      submissions).
- [ ] README/DEPLOYMENT §7 tell the truth about CIUS-RO status and the SPV duty;
      LAUNCH-CHECKLIST carries the ANAF validator step and the fiscal bucket.
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
