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

		// Buyer snapshot, copied from the order at issue time. GDPR erasure
		// leaves these untouched: accounting retention (see README) wins.
		buyerName: text('buyer_name').notNull(),
		buyerEmail: text('buyer_email').notNull().default(''),
		buyerAddress: text('buyer_address').notNull().default(''),
		buyerCompanyName: text('buyer_company_name'),
		buyerCompanyCui: text('buyer_company_cui'),
		buyerCompanyRegCom: text('buyer_company_reg_com'),

		/** Sums of the line amounts (per-line VAT rounding — see vat.ts). */
		netTotalCents: integer('net_total_cents').notNull(),
		vatTotalCents: integer('vat_total_cents').notNull(),
		grossTotalCents: integer('gross_total_cents').notNull(),
		/** Legal mentions snapshot (VAT-unregistered mention, payment terms). */
		mentions: text('mentions').notNull().default('')
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
		// At most one storno per original.
		uniqueIndex('invoices_storno_of_uq').on(table.stornoOfInvoiceId),
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
