import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import type { EmailAttachment } from '../email/service.ts';
import type { Storage } from '../media/storage.ts';
import type { InvoiceDocFormat } from './access.ts';
import { renderEFacturaXml } from './efactura.ts';
import { noopEFacturaSubmitter, type EFacturaSubmitter } from './efactura-submitter.ts';
import { invoiceDocumentFilename, type InvoiceDocumentModel } from './model.ts';
import { renderInvoicePdf } from './pdf.ts';
import { invoiceLines, invoices } from './schema.ts';

/**
 * Rendered fiscal documents (PDF + e-Factura XML) live in the S3 bucket under
 * a dedicated PRIVATE prefix — never the public media prefix (`uploads/`),
 * which imgproxy serves to anyone. Serverless rule: bytes go straight from
 * render to storage, no filesystem in between. Both renderers are
 * deterministic, so "write once" needs no lock: a concurrent re-render
 * produces the identical bytes and the second PUT is a harmless overwrite,
 * while the stat-first check keeps the steady state read-only.
 */

export const INVOICE_DOC_PREFIX = 'invoices/';

const DOC_MIME: Record<InvoiceDocFormat, string> = {
	pdf: 'application/pdf',
	xml: 'application/xml'
};

export function invoiceDocumentKey(invoiceId: string, format: InvoiceDocFormat): string {
	return `${INVOICE_DOC_PREFIX}${invoiceId}.${format}`;
}

export interface InvoiceDocumentDeps {
	db: Db;
	storage: Pick<Storage, 'putObject' | 'statObject' | 'getObjectBytes'>;
	/** ANAF submission seam; the no-op default reports `skipped`, never fakes. */
	efactura?: EFacturaSubmitter;
}

/** The stored snapshot + the original's identification for a storno. */
export async function loadInvoiceModel(
	deps: Pick<InvoiceDocumentDeps, 'db'>,
	invoiceId: string
): Promise<InvoiceDocumentModel | null> {
	const [invoice] = await deps.db.select().from(invoices).where(eq(invoices.id, invoiceId));
	if (!invoice) return null;
	const lines = await deps.db
		.select()
		.from(invoiceLines)
		.where(eq(invoiceLines.invoiceId, invoiceId))
		.orderBy(asc(invoiceLines.position));
	let stornoOf: InvoiceDocumentModel['stornoOf'] = null;
	if (invoice.stornoOfInvoiceId) {
		const [original] = await deps.db
			.select({ displayNumber: invoices.displayNumber, issuedAt: invoices.issuedAt })
			.from(invoices)
			.where(eq(invoices.id, invoice.stornoOfInvoiceId));
		stornoOf = original ?? null;
	}
	return { invoice, lines, stornoOf };
}

async function renderDocument(model: InvoiceDocumentModel, format: InvoiceDocFormat) {
	return format === 'pdf'
		? await renderInvoicePdf(model)
		: new TextEncoder().encode(renderEFacturaXml(model));
}

/**
 * Return the stored document's bytes, rendering and storing them on first
 * request. The first XML store also runs the e-Factura submission seam.
 */
export async function ensureInvoiceDocument(
	deps: InvoiceDocumentDeps,
	model: InvoiceDocumentModel,
	format: InvoiceDocFormat
): Promise<Uint8Array> {
	const key = invoiceDocumentKey(model.invoice.id, format);
	const existing = await deps.storage.statObject(key);
	if (existing) return deps.storage.getObjectBytes(key);

	const bytes = await renderDocument(model, format);
	await deps.storage.putObject(key, bytes, DOC_MIME[format]);
	if (format === 'xml') {
		await (deps.efactura ?? noopEFacturaSubmitter).submit({
			invoiceId: model.invoice.id,
			displayNumber: model.invoice.displayNumber,
			xml: new TextDecoder().decode(bytes)
		});
	}
	return bytes;
}

/** Both documents of one invoice, rendered/stored as needed. */
export async function ensureInvoiceDocuments(
	deps: InvoiceDocumentDeps,
	invoiceId: string
): Promise<{ model: InvoiceDocumentModel; pdf: Uint8Array; xml: Uint8Array } | null> {
	const model = await loadInvoiceModel(deps, invoiceId);
	if (!model) return null;
	const pdf = await ensureInvoiceDocument(deps, model, 'pdf');
	const xml = await ensureInvoiceDocument(deps, model, 'xml');
	return { model, pdf, xml };
}

/** An order's invoice as an email attachment; null while none is issued. */
export async function invoicePdfAttachmentForOrder(
	deps: InvoiceDocumentDeps,
	orderId: string
): Promise<{ invoiceId: string; displayNumber: string; attachment: EmailAttachment } | null> {
	const [invoice] = await deps.db
		.select()
		.from(invoices)
		.where(and(eq(invoices.orderId, orderId), eq(invoices.kind, 'invoice')));
	if (!invoice) return null;
	const model = await loadInvoiceModel(deps, invoice.id);
	if (!model) return null;
	const pdf = await ensureInvoiceDocument(deps, model, 'pdf');
	return {
		invoiceId: invoice.id,
		displayNumber: invoice.displayNumber,
		attachment: {
			filename: invoiceDocumentFilename(invoice, 'pdf'),
			contentType: 'application/pdf',
			content: pdf
		}
	};
}
