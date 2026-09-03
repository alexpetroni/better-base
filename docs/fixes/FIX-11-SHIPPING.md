# FIX-11 — Shipping: a deliverable AWB, a self-healing sync, no dead ends

Audit refs: P1 "Shop & shipping" (Sameday adapter, shipment-sync starvation,
courier-cancelled AWB, status classification); P2 courier call inside the transaction.
See `docs/AUDIT-2026-09-03.md`.

## Problem

`sameday-courier.ts:125-135` sends an empty recipient phone (required by Sameday; never
collected — `phone_number_collection` is off and `customer_details.phone` is unread),
falls back city→county, and discards the 400 body, so every "Generează AWB" will fail
opaquely at launch. The hourly sync (`shipment-service.ts:250-267`) never rotates rows
whose tracking call throws, so a few poisoned AWBs starve the queue; an auth failure fails
every row silently. A courier-side cancelled AWB leaves the order `shipped` forever with no
way to issue a replacement. Status is classified by substring (`includes('livrat')`
matches "nelivrat"). The courier call runs inside the row-locked transaction, so an AWB can
exist at Sameday with no local row.

## Deliverables

1. **Recipient data.** Enable `phone_number_collection` on the checkout session; persist
   `customer_details.phone` into `shippingAddress.phone` (erasure already nulls the jsonb);
   pass it to `createShipment`. `createShipmentForOrder` returns a typed
   `missing-recipient-data` error (listing the missing fields) BEFORE calling the courier
   when phone, county, city or line1 is absent; the admin shows it as a form error with a
   link to edit the address. No city→county fallback. Adapter errors include the response
   body text (bounded) so the operator sees Sameday's reason.
2. **Two-phase AWB creation.** Insert the `shipments` row as `creating` and commit; call
   the courier outside any row lock; update to `registered` (awb, tracking) or `failed`
   (detail) — a retry from `failed` is allowed; use `clientInternalReference = order.id`.
3. **Sync rotation and health.** On a thrown tracking call: bump `last_synced_at`, set
   `next_sync_at` with exponential backoff, increment `error_count`, keep the last error
   text (migration). Abort the run on the first auth error (log at error level). The cron
   response includes `errors`; runs with errors write a `shipment-sync-error` event on the
   affected orders and the admin dashboard shows a "sync failing" banner while
   `error_count > 0` rows exist.
4. **Cancelled AWB path.** Courier `cancelled` (outside the refund path): transition
   `shipped → packed` (new edge restricted to the sync/awb actors), mark the shipment row
   `cancelled`, event `awb-cancelled-externally`; `createShipmentForOrder` proceeds when
   the existing row is `cancelled` or `failed` (partial unique index on non-terminal
   statuses, migration).
5. **Status classification.** Classify on Sameday's numeric `statusId` with a maintained
   table; anchored text patterns with explicit negatives as the fallback; unknown texts log
   at warn level with the raw payload and map to `in-transit`. Capture-real-payload
   instructions go into LAUNCH-CHECKLIST (live-AWB step) and DEPLOYMENT §7.

## Tests

- **Integration (must FAIL on current code):** a shipment for an order without a phone
  returns `missing-recipient-data` and the mock courier is never called; with phone +
  county the request carries both.
- Unit: adapter error includes the response body; county never falls back to city.
- Integration: courier throws mid-create after the `creating` row exists → row is
  `failed` with detail, retry succeeds, exactly one AWB registered.
- Integration (two runs): one throwing row does not block the next row; `error_count` and
  backoff advance; an auth error aborts the run with the count reported.
- Integration: courier `cancelled` → order back to `packed`, replacement AWB possible.
- Unit: the status table — `nelivrat`, `livrat`, `anulat`, `in tranzit`, unknown text.

## Definition of Done

- [ ] Gate green; the recipient-data and rotation regressions pass, each added in a test-first commit that precedes its fix in `git log`.
- [ ] `pnpm db:migrate` clean on fresh and populated DBs.
- [ ] DEPLOYMENT.md §7 / LAUNCH-CHECKLIST updated (phone collection, live-AWB fixture step).
- [ ] Both `SITE_ID`s boot; STATE.md updated; work committed.
