import type { InvoiceLineRow, InvoiceRow } from './schema.ts';

/**
 * The input both document renderers (PDF and e-Factura XML) work from: the
 * stored snapshot, nothing else. A storno additionally carries the original
 * document's identification — the reversal must reference it (PDF mention,
 * UBL BillingReference) and the reference is part of the stored record
 * (`storno_of_invoice_id`), not a lookup at render time.
 */
export interface InvoiceDocumentModel {
	invoice: InvoiceRow;
	lines: InvoiceLineRow[];
	/** Set exactly when `invoice.kind === 'storno'`. */
	stornoOf: { displayNumber: string; issuedAt: Date } | null;
}

/**
 * Invoice dates are Romanian legal dates: format them in the issuer's
 * timezone, not UTC — an invoice issued 00:30 EET must not carry yesterday's
 * date. en-CA yields ISO YYYY-MM-DD directly.
 */
const RO_DAY = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'Europe/Bucharest',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});

/** `2026-08-07` — the e-Factura (UBL) date format. */
export function invoiceDateIso(date: Date): string {
	return RO_DAY.format(date);
}

/** `07.08.2026` — the human-facing date format printed on the PDF. */
export function invoiceDateRo(date: Date): string {
	const [year, month, day] = invoiceDateIso(date).split('-');
	return `${day}.${month}.${year}`;
}

/** ASCII download filename: `Factura-BSL-0042.pdf` / `Storno-BSL-0043.xml`. */
export function invoiceDocumentFilename(invoice: InvoiceRow, format: 'pdf' | 'xml'): string {
	const prefix = invoice.kind === 'storno' ? 'Storno' : 'Factura';
	const safeNumber = invoice.displayNumber.replace(/[^A-Za-z0-9-]+/g, '-');
	return `${prefix}-${safeNumber}.${format}`;
}
