import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { centsPerUnitToDecimal, formatCents } from '../../util/money.ts';
import { DEJAVU_SANS_TTF_BASE64 } from './fonts/dejavu-sans.ts';
import { invoiceDateRo, type InvoiceDocumentModel } from './model.ts';

/**
 * The invoice PDF renderer: pure and DETERMINISTIC — the same snapshot
 * renders byte-identical PDFs on every run. Everything that pdf-lib would
 * otherwise stamp per run (creation/modification dates, producer) is pinned
 * to the invoice's own stored fields, and the embedded font subset is named
 * explicitly. No filesystem, no native code, no headless browser — plain
 * pdf-lib + fontkit on the base64-embedded DejaVu Sans (see fonts/ and the
 * module README for the choice and its size cost), which covers the Romanian
 * comma-below diacritics (ș ț Ș Ț) correctly.
 */

const PAGE_WIDTH = 595.28; // A4 portrait, points
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

const INK = rgb(0.1, 0.1, 0.16);
const MUTED = rgb(0.42, 0.44, 0.5);
const RULE = rgb(0.78, 0.8, 0.85);

/** Table column widths (sum = CONTENT_WIDTH). */
const COLS = [
	{ key: 'pos', width: 16, align: 'left' },
	{ key: 'description', width: 172, align: 'left' },
	{ key: 'qty', width: 30, align: 'right' },
	{ key: 'unitNet', width: 74, align: 'right' },
	{ key: 'net', width: 66, align: 'right' },
	{ key: 'rate', width: 32, align: 'right' },
	{ key: 'vat', width: 55, align: 'right' },
	{ key: 'gross', width: 70.28, align: 'right' }
] as const;

type ColKey = (typeof COLS)[number]['key'];

/** 2100 bp → "21%", 1950 bp → "19,5%". */
export function formatVatRateBp(rateBp: number): string {
	const whole = Math.trunc(rateBp / 100);
	const frac = rateBp % 100;
	if (frac === 0) return `${whole}%`;
	const fracText = String(frac).padStart(2, '0').replace(/0$/, '');
	return `${whole},${fracText}%`;
}

/** Greedy word wrap by measured width; a word longer than the width is cut. */
function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split('\n')) {
		let current = '';
		for (const word of paragraph.split(/\s+/).filter(Boolean)) {
			const candidate = current ? `${current} ${word}` : word;
			if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
				current = candidate;
				continue;
			}
			if (current) lines.push(current);
			current = word;
			while (font.widthOfTextAtSize(current, size) > maxWidth && current.length > 1) {
				let keep = current.length - 1;
				while (keep > 1 && font.widthOfTextAtSize(current.slice(0, keep), size) > maxWidth) {
					keep -= 1;
				}
				lines.push(current.slice(0, keep));
				current = current.slice(keep);
			}
		}
		lines.push(current);
	}
	return lines;
}

interface Renderer {
	doc: PDFDocument;
	font: PDFFont;
	page: PDFPage;
	y: number;
}

function addPage(r: Renderer): void {
	r.page = r.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
	r.y = PAGE_HEIGHT - MARGIN;
}

function drawText(
	r: Renderer,
	text: string,
	x: number,
	size: number,
	opts?: { color?: ReturnType<typeof rgb>; rightEdge?: number }
): void {
	const drawX =
		opts?.rightEdge !== undefined ? opts.rightEdge - r.font.widthOfTextAtSize(text, size) : x;
	r.page.drawText(text, { x: drawX, y: r.y, size, font: r.font, color: opts?.color ?? INK });
}

function drawRule(r: Renderer, yOffset = 3): void {
	r.page.drawLine({
		start: { x: MARGIN, y: r.y + yOffset },
		end: { x: MARGIN + CONTENT_WIDTH, y: r.y + yOffset },
		thickness: 0.6,
		color: RULE
	});
}

function drawTableHeader(r: Renderer): void {
	const labels: Record<ColKey, string> = {
		pos: '#',
		description: 'Denumire produs / serviciu',
		qty: 'Cant.',
		unitNet: 'Preț unitar fără TVA',
		net: 'Valoare fără TVA',
		rate: 'TVA',
		vat: 'Valoare TVA',
		gross: 'Total'
	};
	// Two-line header cells keep the narrow money columns readable.
	let x = MARGIN;
	for (const col of COLS) {
		const lines = wrapText(r.font, labels[col.key], 7, col.width - 4);
		let cellY = r.y;
		for (const line of lines.slice(0, 2)) {
			r.page.drawText(line, {
				x: col.align === 'right' ? x + col.width - r.font.widthOfTextAtSize(line, 7) : x,
				y: cellY,
				size: 7,
				font: r.font,
				color: MUTED
			});
			cellY -= 8;
		}
		x += col.width + 0;
	}
	r.y -= 18;
	drawRule(r, 12);
}

/**
 * "Achitat cu cardul la 07.08.2026 (ref. pi_…)" on a settled invoice — the
 * document is prepaid, nothing is due; a storno reports the refund the same
 * way. '' while the document is still payable.
 */
function paymentLine(invoice: InvoiceDocumentModel['invoice']): string {
	if (!invoice.paidAt) return '';
	const verb = invoice.kind === 'storno' ? 'Rambursat' : 'Achitat';
	const means =
		invoice.paymentMethod === 'card'
			? invoice.kind === 'storno'
				? 'pe card'
				: 'cu cardul'
			: invoice.paymentMethod
				? 'online'
				: '';
	const reference = invoice.paymentReference ? ` (ref. ${invoice.paymentReference})` : '';
	return `${[verb, means].filter(Boolean).join(' ')} la ${invoiceDateRo(invoice.paidAt)}${reference}`;
}

/** Render the stored snapshot to PDF bytes. Async only because pdf-lib is. */
export async function renderInvoicePdf(model: InvoiceDocumentModel): Promise<Uint8Array> {
	const { invoice, lines, stornoOf } = model;
	const isStorno = invoice.kind === 'storno';

	const doc = await PDFDocument.create();
	doc.registerFontkit(fontkit);
	// Pin every per-run stamp to the snapshot: identical input ⇒ identical bytes.
	const kindLabel = isStorno ? 'Factură storno' : 'Factură';
	doc.setTitle(`${kindLabel} ${invoice.displayNumber}`);
	doc.setProducer('better-base');
	doc.setCreator('better-base');
	doc.setCreationDate(invoice.issuedAt);
	doc.setModificationDate(invoice.issuedAt);
	const font = await doc.embedFont(Buffer.from(DEJAVU_SANS_TTF_BASE64, 'base64'), {
		subset: true,
		customName: 'DejaVuSans'
	});

	const r: Renderer = { doc, font, page: undefined as unknown as PDFPage, y: 0 };
	addPage(r);

	// --- Document header: kind, number, dates (top-right); issuer (top-left).
	drawText(r, isStorno ? 'FACTURĂ STORNO' : 'FACTURĂ', 0, 16, {
		rightEdge: MARGIN + CONTENT_WIDTH
	});
	r.y -= 16;
	drawText(r, invoice.displayNumber, 0, 11, { rightEdge: MARGIN + CONTENT_WIDTH });
	r.y -= 13;
	drawText(r, `Data emiterii: ${invoiceDateRo(invoice.issuedAt)}`, 0, 9, {
		rightEdge: MARGIN + CONTENT_WIDTH,
		color: MUTED
	});
	if (isStorno && stornoOf) {
		r.y -= 12;
		drawText(
			r,
			`Stornează factura ${stornoOf.displayNumber} din ${invoiceDateRo(stornoOf.issuedAt)}`,
			0,
			9,
			{ rightEdge: MARGIN + CONTENT_WIDTH }
		);
	}

	// Issuer block, aligned with the header on the left.
	r.y = PAGE_HEIGHT - MARGIN;
	drawText(r, 'Furnizor', MARGIN, 8, { color: MUTED });
	r.y -= 12;
	drawText(r, invoice.issuerName, MARGIN, 11);
	r.y -= 13;
	const issuerLines = [
		`CUI: ${invoice.issuerCui}`,
		`Nr. Reg. Com.: ${invoice.issuerRegCom}`,
		// Legea 31/1990 art. 74: the share capital under the Reg. Com. number.
		invoice.issuerCapital ? `Capital social: ${invoice.issuerCapital}` : '',
		...wrapText(font, invoice.issuerAddress, 9, 280),
		[invoice.issuerEmail, invoice.issuerPhone].filter(Boolean).join(' · '),
		invoice.issuerIban
			? `IBAN: ${invoice.issuerIban}${invoice.issuerBank ? ` (${invoice.issuerBank})` : ''}`
			: ''
	].filter(Boolean);
	for (const line of issuerLines) {
		drawText(r, line, MARGIN, 9);
		r.y -= 11;
	}

	// --- Buyer block.
	r.y = Math.min(r.y, PAGE_HEIGHT - MARGIN - 110) - 14;
	drawText(r, 'Cumpărător', MARGIN, 8, { color: MUTED });
	r.y -= 12;
	drawText(r, invoice.buyerName, MARGIN, 11);
	r.y -= 13;
	const buyerLines = [
		invoice.buyerCompanyCui ? `CUI: ${invoice.buyerCompanyCui}` : '',
		invoice.buyerCompanyRegCom ? `Nr. Reg. Com.: ${invoice.buyerCompanyRegCom}` : '',
		...invoice.buyerAddress.split('\n').filter(Boolean),
		invoice.buyerEmail
	].filter(Boolean);
	for (const line of buyerLines) {
		drawText(r, line, MARGIN, 9);
		r.y -= 11;
	}

	// --- Line table.
	r.y -= 16;
	drawTableHeader(r);
	const currency = invoice.currency;
	for (const line of lines) {
		const cells: Record<ColKey, string> = {
			pos: String(line.position),
			description: line.description,
			qty: String(line.qty),
			unitNet: centsPerUnitToDecimal(line.netCents, line.qty, ','),
			net: formatCents(line.netCents, currency),
			rate: formatVatRateBp(line.vatRateBp),
			vat: formatCents(line.vatCents, currency),
			gross: formatCents(line.grossCents, currency)
		};
		const descLines = wrapText(font, cells.description, 8.5, COLS[1].width - 6);
		const rowHeight = Math.max(descLines.length, 1) * 10 + 6;
		if (r.y - rowHeight < 130) {
			addPage(r);
			drawTableHeader(r);
		}
		let x = MARGIN;
		for (const col of COLS) {
			const value = cells[col.key];
			if (col.key === 'description') {
				let cellY = r.y;
				for (const descLine of descLines) {
					r.page.drawText(descLine, { x, y: cellY, size: 8.5, font, color: INK });
					cellY -= 10;
				}
			} else {
				r.page.drawText(value, {
					x: col.align === 'right' ? x + col.width - font.widthOfTextAtSize(value, 8.5) : x,
					y: r.y,
					size: 8.5,
					font,
					color: INK
				});
			}
			x += col.width;
		}
		r.y -= rowHeight;
		drawRule(r, rowHeight - 4);
	}

	// --- Totals, right-aligned under the table.
	r.y -= 10;
	const totals: Array<[string, number, number]> = [
		['Total fără TVA', invoice.netTotalCents, 9],
		['Total TVA', invoice.vatTotalCents, 9],
		['TOTAL DE PLATĂ', invoice.grossTotalCents, 11]
	];
	for (const [label, cents, size] of totals) {
		drawText(r, label, 0, size, { rightEdge: MARGIN + CONTENT_WIDTH - 110, color: MUTED });
		drawText(r, formatCents(cents, currency), 0, size, { rightEdge: MARGIN + CONTENT_WIDTH });
		r.y -= size + 5;
	}

	// --- Order + payment references, legal mentions, place of issue.
	const mentionLines = [
		invoice.orderReference ? `Comandă: ${invoice.orderReference}` : '',
		paymentLine(invoice),
		...invoice.mentions.split('\n').filter(Boolean),
		invoice.issuerPlace ? `Emisă la ${invoice.issuerPlace}` : ''
	].filter(Boolean);
	if (mentionLines.length > 0) {
		r.y -= 14;
		for (const mention of mentionLines) {
			for (const line of wrapText(font, mention, 8.5, CONTENT_WIDTH)) {
				if (r.y < MARGIN + 10) addPage(r);
				drawText(r, line, MARGIN, 8.5, { color: MUTED });
				r.y -= 11;
			}
		}
	}

	return doc.save();
}
