import { error } from '@sveltejs/kit';
import { and, asc, gte, inArray, lt, sql } from 'drizzle-orm';
import { zipSync, type Zippable } from 'fflate';
import { getDb } from '$lib/db';
import {
	ensureInvoiceDocument,
	invoiceDateIso,
	invoiceDocumentFilename,
	invoiceLines,
	invoices,
	loadInvoiceModel
} from '$lib/modules/invoice/server';
import { recordAdminAudit } from '$lib/modules/auth';
import { getInvoiceStorage } from '$lib/modules/media/server';
import { requireAdmin } from '$lib/server/forms';
import { CSV_BOM, csvField } from '$lib/util/csv';
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
 *
 * CSV hygiene (FIX-12): UTF-8 BOM (ro-RO Excel), every text cell through the
 * shared `csvField` (formula injection neutralised — buyer names are
 * customer input), one base/VAT column pair per VAT rate present in the
 * month (the accountant's journal is per rate), and the month window
 * computed in SQL on the Europe/Bucharest calendar the documents are dated
 * in, so the query uses the issued_at index instead of scanning the table.
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

/** `[start, end)` of `YYYY-MM` as instants, on the Romanian legal calendar. */
function bucharestMonthWindow(month: string): { start: Date; end: Date } {
	const [year, monthNumber] = month.split('-').map(Number);
	const startLocal = `${month}-01`;
	const next = new Date(Date.UTC(year, monthNumber, 1)); // monthNumber is 1-based → next month
	const endLocal = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
	return { start: bucharestMidnight(startLocal), end: bucharestMidnight(endLocal) };
}

/**
 * The instant of 00:00 Europe/Bucharest on `YYYY-MM-DD`. The zone offset at
 * 00:00 UTC of that day is the offset at local midnight too: RO changes
 * clocks at 03:00/04:00 local on a late-March/late-October Sunday, never
 * within the hours around a month's first midnight.
 */
function bucharestMidnight(localDate: string): Date {
	const utcMidnight = new Date(`${localDate}T00:00:00Z`);
	return new Date(utcMidnight.getTime() - bucharestOffsetMs(utcMidnight));
}

/** Europe/Bucharest's UTC offset at `at`, in ms (EET +2h / EEST +3h). */
function bucharestOffsetMs(at: Date): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: 'Europe/Bucharest',
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	}).formatToParts(at);
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
	const asUtc = Date.UTC(
		get('year'),
		get('month') - 1,
		get('day'),
		get('hour'),
		get('minute'),
		get('second')
	);
	return asUtc - at.getTime();
}

export const GET: RequestHandler = async ({ url, locals }) => {
	// Defense in depth on top of the admin-section route guard.
	const user = requireAdmin(locals);

	const month = url.searchParams.get('month') ?? '';
	if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) error(400, 'month must be YYYY-MM');

	const db = getDb();
	await recordAdminAudit(db, { actor: user.email, action: 'orders-export', target: month });
	const storage = getInvoiceStorage();

	// Documents are dated in Europe/Bucharest (like the documents themselves),
	// so the month window is the Romanian calendar month, expressed as
	// instants for the indexed `issued_at` column.
	const window = bucharestMonthWindow(month);
	const monthRows = await db
		.select()
		.from(invoices)
		.where(and(gte(invoices.issuedAt, window.start), lt(invoices.issuedAt, window.end)))
		.orderBy(asc(invoices.series), asc(invoices.number));

	// One (base, VAT) column pair per rate present in the month, highest first.
	const perRate = new Map<string, Map<number, { net: number; vat: number }>>();
	if (monthRows.length > 0) {
		const lines = await db
			.select({
				invoiceId: invoiceLines.invoiceId,
				vatRateBp: invoiceLines.vatRateBp,
				net: sql<number>`sum(${invoiceLines.netCents})::int`,
				vat: sql<number>`sum(${invoiceLines.vatCents})::int`
			})
			.from(invoiceLines)
			.where(
				inArray(
					invoiceLines.invoiceId,
					monthRows.map((row) => row.id)
				)
			)
			.groupBy(invoiceLines.invoiceId, invoiceLines.vatRateBp);
		for (const line of lines) {
			const byRate = perRate.get(line.invoiceId) ?? new Map();
			byRate.set(line.vatRateBp, { net: Number(line.net), vat: Number(line.vat) });
			perRate.set(line.invoiceId, byRate);
		}
	}
	const rates = [...new Set([...perRate.values()].flatMap((byRate) => [...byRate.keys()]))].sort(
		(a, b) => b - a
	);
	const rateLabel = (bp: number) => (bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2));

	const entries: Zippable = {};
	const csvLines = [
		[
			...CSV_HEADER,
			...rates.flatMap((bp) => [`baza_${rateLabel(bp)}`, `tva_${rateLabel(bp)}`])
		].join(';')
	];
	for (const row of monthRows) {
		const model = await loadInvoiceModel({ db }, row.id);
		if (!model) continue;
		const byRate = perRate.get(row.id);
		csvLines.push(
			[
				csvField(row.displayNumber, ';'),
				row.kind === 'storno' ? 'storno' : 'factura',
				invoiceDateIso(row.issuedAt),
				csvField(row.buyerCompanyName ?? row.buyerName, ';'),
				csvField(row.buyerCompanyCui ?? '', ';'),
				centsToDecimal(row.netTotalCents, ','),
				centsToDecimal(row.vatTotalCents, ','),
				centsToDecimal(row.grossTotalCents, ','),
				row.currency.toUpperCase(),
				csvField(model.stornoOf?.displayNumber ?? '', ';'),
				...rates.flatMap((bp) => {
					const amounts = byRate?.get(bp) ?? { net: 0, vat: 0 };
					return [centsToDecimal(amounts.net, ','), centsToDecimal(amounts.vat, ',')];
				})
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
	entries['facturi.csv'] = new TextEncoder().encode(CSV_BOM + csvLines.join('\n') + '\n');

	return new Response(new Uint8Array(zipSync(entries)), {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename="facturi-${month}.zip"`,
			'cache-control': 'private, no-store'
		}
	});
};
