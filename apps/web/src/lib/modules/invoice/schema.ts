import {
	boolean,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orders } from '../shop/schema.ts';

/**
 * The fiscal record (NEXT-6). Invoices are APPEND-ONLY legal documents: a row
 * is inserted once at issue time with a complete snapshot of issuer, buyer and
 * amounts, and is never updated or deleted afterwards — a mistake is corrected
 * by issuing a storno (reversal) document that references the original. The
 * append-only rule is enforced by DB triggers (see migration 0016) on top of
 * the service layer, and orders referenced by an invoice cannot be deleted
 * (plain FK, no cascade).
 */

/**
 * One row per declared invoice series, holding the next number to assign.
 * Numbering is gapless and race-free: issuance increments `next_number` under
 * the row lock the UPDATE takes, inside the same transaction that inserts the
 * invoice — two concurrent issuances serialize on the lock, and a rolled-back
 * issuance rolls the counter back with it. The row is created on first use,
 * seeded from the `invoice.seriesPrefix` / `invoice.nextNumber` settings;
 * afterwards THIS row is the authority (later settings edits do not renumber).
 */
export const invoiceSeries = pgTable('invoice_series', {
	series: text('series').primaryKey(),
	nextNumber: integer('next_number').notNull()
});

export const invoices = pgTable(
	'invoices',
	{
		id: text('id').primaryKey(),
		/** A storno negates the invoice it references; both live in one series. */
		kind: text('kind', { enum: ['invoice', 'storno'] }).notNull(),
		series: text('series').notNull(),
		number: integer('number').notNull(),
		/** Composed human-facing number, e.g. `BSL-0042`. */
		displayNumber: text('display_number').notNull(),
		/** Nullable: a manual invoice without an order stays possible later. */
		orderId: text('order_id').references(() => orders.id),
		stornoOfInvoiceId: text('storno_of_invoice_id').references((): AnyPgColumn => invoices.id),
		issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
		/** Orders are paid before issuance, so due date = issue date. */
		dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
		currency: text('currency').notNull(),

		// Issuer identification, COPIED from settings at issue time — a later
		// settings edit must not rewrite issued documents.
		issuerName: text('issuer_name').notNull(),
		issuerCui: text('issuer_cui').notNull(),
		issuerVatRegistered: boolean('issuer_vat_registered').notNull(),
		issuerRegCom: text('issuer_reg_com').notNull(),
		issuerAddress: text('issuer_address').notNull(),
		issuerPlace: text('issuer_place').notNull().default(''),
		issuerEmail: text('issuer_email').notNull().default(''),
		issuerPhone: text('issuer_phone').notNull().default(''),
		issuerIban: text('issuer_iban').notNull().default(''),
		issuerBank: text('issuer_bank').notNull().default(''),
		// Structured seller address (FIX-12, CIUS-RO): `issuer_address` above
		// stays the printable composition of these. County = ISO 3166-2:RO.
		issuerStreet: text('issuer_street').notNull().default(''),
		issuerCity: text('issuer_city').notNull().default(''),
		issuerCounty: text('issuer_county').notNull().default(''),
		issuerPostalCode: text('issuer_postal_code').notNull().default(''),
		issuerCountry: text('issuer_country').notNull().default(''),
		/** Share capital as stated on the document (Legea 31/1990 art. 74); '' for a PFA. */
		issuerCapital: text('issuer_capital').notNull().default(''),

		// Buyer snapshot, copied from the order at issue time. GDPR erasure
		// leaves these untouched: accounting retention (see README) wins.
		buyerName: text('buyer_name').notNull(),
		buyerEmail: text('buyer_email').notNull().default(''),
		buyerAddress: text('buyer_address').notNull().default(''),
		buyerCompanyName: text('buyer_company_name'),
		buyerCompanyCui: text('buyer_company_cui'),
		buyerCompanyRegCom: text('buyer_company_reg_com'),
		// Structured buyer address (FIX-12): the company's seat for B2B, the
		// Stripe shipping address (county mapped to its code) for B2C. Rows
		// issued before FIX-12 carry '' here and render from `buyer_address`.
		buyerStreet: text('buyer_street').notNull().default(''),
		buyerCity: text('buyer_city').notNull().default(''),
		buyerCounty: text('buyer_county').notNull().default(''),
		buyerPostalCode: text('buyer_postal_code').notNull().default(''),
		buyerCountry: text('buyer_country').notNull().default(''),

		/** Sums of the line amounts (per-line VAT rounding — see vat.ts). */
		netTotalCents: integer('net_total_cents').notNull(),
		vatTotalCents: integer('vat_total_cents').notNull(),
		grossTotalCents: integer('gross_total_cents').notNull(),
		/** Legal mentions snapshot (VAT-unregistered mention, payment terms). */
		mentions: text('mentions').notNull().default(''),
		/**
		 * BT-120 for a category-O (neplătitor) document, in its OWN column so a
		 * payment-terms note can never become the exemption reason (FIX-12);
		 * '' on a registered issuer's document and on pre-FIX-12 rows.
		 */
		vatExemptionReason: text('vat_exemption_reason').notNull().default(''),
		/** The order id (UBL OrderReference / "Comandă" on the PDF). */
		orderReference: text('order_reference').notNull().default(''),
		/** The payment processor's reference (Stripe payment intent). */
		paymentReference: text('payment_reference').notNull().default(''),
		/** `card` | `online` as the order recorded it; '' when unknown. */
		paymentMethod: text('payment_method').notNull().default(''),
		/**
		 * When the document was settled: the invoice is PREPAID (PrepaidAmount =
		 * total, PayableAmount 0, "Achitat … la"); null = still payable.
		 */
		paidAt: timestamp('paid_at', { withTimezone: true })
	},
	(table) => [
		// The gapless-numbering safety net: a duplicate (series, number) can
		// never commit, whatever bug tries to produce one.
		uniqueIndex('invoices_series_number_uq').on(table.series, table.number),
		// At most ONE invoice per order (stornos excepted) — the idempotency
		// backstop under the service checks.
		uniqueIndex('invoices_order_invoice_uq')
			.on(table.orderId)
			.where(sql`${table.kind} = 'invoice'`),
		// Stornos may be PARTIAL (a partial refund reverses only the refunded
		// amount), so several may reference one original. The bound Σ storno
		// gross ≤ original gross is a BEFORE INSERT trigger (migration 0022).
		index('invoices_storno_of_idx').on(table.stornoOfInvoiceId),
		index('invoices_order_id_idx').on(table.orderId)
	]
);

export const invoiceLines = pgTable(
	'invoice_lines',
	{
		id: text('id').primaryKey(),
		invoiceId: text('invoice_id')
			.notNull()
			.references(() => invoices.id),
		/** 1-based print order. */
		position: integer('position').notNull(),
		description: text('description').notNull(),
		/** Negative on a storno line (amounts negate with it). */
		qty: integer('qty').notNull(),
		/** Gross unit price in bani, as paid (prices include VAT). */
		unitPriceCents: integer('unit_price_cents').notNull(),
		/** VAT rate in basis points (2100 = 21%); 0 for an unregistered issuer. */
		vatRateBp: integer('vat_rate_bp').notNull(),
		netCents: integer('net_cents').notNull(),
		vatCents: integer('vat_cents').notNull(),
		grossCents: integer('gross_cents').notNull()
	},
	(table) => [index('invoice_lines_invoice_id_idx').on(table.invoiceId)]
);

export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceKind = InvoiceRow['kind'];
export type InvoiceLineRow = typeof invoiceLines.$inferSelect;
export type InvoiceSeriesRow = typeof invoiceSeries.$inferSelect;
