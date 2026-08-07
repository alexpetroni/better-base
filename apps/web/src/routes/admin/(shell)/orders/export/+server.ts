import { error } from '@sveltejs/kit';
import { asc } from 'drizzle-orm';
import { zipSync, type Zippable } from 'fflate';
import { getDb } from '$lib/db';
import {
	ensureInvoiceDocument,
	invoiceDateIso,
	invoiceDocumentFilename,
	invoices,
	loadInvoiceModel
} from '$lib/modules/invoice/server';
import { getStorage } from '$lib/modules/media/server';
import { centsToDecimal } from '$lib/util/money';
import type { RequestHandler } from './$types';

/**
 * The accountant's monthly export: `/admin/orders/export?month=YYYY-MM` →
 * one zip with `facturi.csv` (semicolon-separated, comma decimals — what a
 * Romanian-locale Excel/accounting import expects) plus every fiscal
 * document of the month as PDF and e-Factura XML. One archive per month is
 * the shape bookkeeping actually consumes: the CSV drives the journal entry,
 * the files are the attached justifying documents. Zip is built in memory —
 * an SMB month of invoices at ~12 KB a PDF is a few MB, nowhere near a
 * serverless limit — and written to no filesystem.
 */

const CSV_HEADER = [
	'numar',
	'tip',
	'data',
	'cumparator',
	'cui_cumparator',
	'valoare_fara_tva',
	'tva',
	'total',
	'moneda',
	'storneaza'
];

function csvField(value: string): string {
	return /[;"\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export const GET: RequestHandler = async ({ url, locals }) => {
	// Defense in depth on top of the admin-section route guard.
	if (locals.user?.role !== 'admin') error(403);

	const month = url.searchParams.get('month') ?? '';
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) error(400, 'month must be YYYY-MM');

	const db = getDb();
	const storage = getStorage();

	// Documents are dated in Europe/Bucharest (like the documents themselves),
	// so the month filter uses the same calendar — filtered here rather than
	// in SQL to keep one source of truth for the timezone rule.
	const all = await db.select().from(invoices).orderBy(asc(invoices.series), asc(invoices.number));
	const monthRows = all.filter((row) => invoiceDateIso(row.issuedAt).startsWith(month));

	const entries: Zippable = {};
	const csvLines = [CSV_HEADER.join(';')];
	for (const row of monthRows) {
		const model = await loadInvoiceModel({ db }, row.id);
		if (!model) continue;
		csvLines.push(
			[
				row.displayNumber,
				row.kind === 'storno' ? 'storno' : 'factura',
				invoiceDateIso(row.issuedAt),
				csvField(row.buyerCompanyName ?? row.buyerName),
				row.buyerCompanyCui ?? '',
				centsToDecimal(row.netTotalCents, ','),
				centsToDecimal(row.vatTotalCents, ','),
				centsToDecimal(row.grossTotalCents, ','),
				row.currency.toUpperCase(),
				model.stornoOf?.displayNumber ?? ''
			].join(';')
		);
		const mtime = row.issuedAt;
		entries[invoiceDocumentFilename(row, 'pdf')] = [
			await ensureInvoiceDocument({ db, storage }, model, 'pdf'),
			{ mtime }
		];
		entries[invoiceDocumentFilename(row, 'xml')] = [
			await ensureInvoiceDocument({ db, storage }, model, 'xml'),
			{ mtime }
		];
	}
	entries['facturi.csv'] = new TextEncoder().encode(csvLines.join('\n') + '\n');

	return new Response(new Uint8Array(zipSync(entries)), {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename="facturi-${month}.zip"`,
			'cache-control': 'private, no-store'
		}
	});
};
