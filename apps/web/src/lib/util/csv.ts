/**
 * CSV cell hygiene shared by every admin export (FIX-12, audit P2):
 * - `CSV_BOM` — a UTF-8 byte-order mark at the top of the file is what makes
 *   a ro-RO Excel read "Pernă" instead of mojibake;
 * - `csvField` — quotes what the delimiter/quotes/line breaks require and
 *   NEUTRALISES formula injection: a cell starting with `=` `+` `-` `@`, a
 *   tab or a CR is executed by Excel/LibreOffice, and customer-entered names
 *   are attacker input. A leading apostrophe keeps the text readable and
 *   inert (the OWASP CSV-injection mitigation).
 */

export const CSV_BOM = '\uFEFF';

const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

export function csvField(value: string | null | undefined, delimiter: ';' | ','): string {
	let text = value ?? '';
	if (text.length > 0 && FORMULA_LEADERS.has(text[0])) text = `'${text}`;
	const needsQuotes = text.includes(delimiter) || /["\n\r]/.test(text);
	return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}
