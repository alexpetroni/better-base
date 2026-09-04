import { parseLeiToCents } from './money.ts';

/**
 * VAT rates as DATA, in integer basis points.
 *
 * `RO_VAT_RATES_BP` is the Romanian legal rate table (Codul fiscal art. 291:
 * 21 % standard and 11 % reduced since 2025-08-01; 19 %, 9 % and 5 % before
 * — kept for orders and corrections dated under the old regime). It is the
 * allowlist behind the per-product rate and the standard-rate schedule: a
 * typo (22 %) or a percent typed as basis points (21) can never reach an
 * invoice, and ZERO is deliberately absent — a 0 % line on a VAT-registered
 * issuer would emit e-Factura category Z by accident (audit 2026-09-03 P2
 * "VAT category holes"); the unregistered issuer's 0 % is a separate,
 * explicit state (`company.vatRegistered` off). When the law changes, this
 * table is the one place to extend.
 *
 * The STANDARD rate is effective-dated (audit P1 "no effective dating"):
 * `invoice.vatStandardRates` is a multiline setting, one `YYYY-MM-DD percent`
 * line per rate change, and issuance selects the entry in force on the
 * ORDER date — so a retry after a rate change never invoices yesterday's
 * order at today's rate. Everything here is pure and integer-only.
 */

export const RO_VAT_RATES_BP: readonly number[] = [500, 900, 1100, 1900, 2100];

export function isAllowedVatRateBp(bp: unknown): bp is number {
	return typeof bp === 'number' && RO_VAT_RATES_BP.includes(bp);
}

export interface VatRateScheduleEntry {
	/** First day (Bucharest calendar) the rate applies, `YYYY-MM-DD`. */
	from: string;
	/** Rate in basis points, from `RO_VAT_RATES_BP`. */
	bp: number;
}

/** Sorted ascending by `from`; never empty (the parser refuses an empty schedule). */
export type VatRateSchedule = VatRateScheduleEntry[];

const ENTRY_PATTERN = /^(\d{4}-\d{2}-\d{2})\s*[:=]?\s*(\d{1,2}(?:[.,]\d{1,2})?)$/;

function isCalendarDay(day: string): boolean {
	const [year, month, dayOfMonth] = day.split('-').map(Number);
	if (month < 1 || month > 12 || dayOfMonth < 1) return false;
	// Day-of-month bound via the (UTC) calendar; the string never carries a time.
	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return dayOfMonth <= daysInMonth;
}

/**
 * Parse the operator-typed schedule. One entry per non-empty line:
 * `2025-08-01 21` (also `2025-08-01: 21` / `= 21`); the percent is converted
 * with the same integer parser as prices ("19,5" → 1950). Null on anything
 * malformed, a duplicate date, an unlisted rate, or no entries at all —
 * the settings validator maps null to `invalid-vat-rate`.
 */
export function parseVatRateSchedule(text: string): VatRateSchedule | null {
	const entries: VatRateSchedule = [];
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		const match = ENTRY_PATTERN.exec(line);
		if (!match) return null;
		const [, from, percent] = match;
		if (!isCalendarDay(from)) return null;
		const bp = parseLeiToCents(percent);
		if (bp === null || !isAllowedVatRateBp(bp)) return null;
		if (entries.some((entry) => entry.from === from)) return null;
		entries.push({ from, bp });
	}
	if (entries.length === 0) return null;
	entries.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
	return entries;
}

/** The canonical text form of a schedule (sorted, one entry per line). */
export function formatVatRateSchedule(schedule: VatRateScheduleEntry[]): string {
	return [...schedule]
		.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
		.map((entry) => `${entry.from} ${vatRateBpToPercentText(entry.bp)}`)
		.join('\n');
}

/**
 * The standard rate in force on `dayIso` (a `YYYY-MM-DD` Bucharest calendar
 * day — callers derive it from the order date with `invoiceDateIso`): the
 * latest entry whose `from` is on or before the day. A day before the
 * schedule starts takes the EARLIEST entry — the operator's schedule is
 * the only history the app has, and every order this platform has ever
 * taken postdates the 2025-08-01 default.
 */
export function standardVatRateAt(schedule: VatRateSchedule, dayIso: string): number {
	let selected = schedule[0];
	for (const entry of schedule) {
		if (entry.from <= dayIso) selected = entry;
		else break;
	}
	return selected.bp;
}

/** 2100 → "21", 1950 → "19,5", 525 → "5,25" (comma decimal — the RO form). */
export function vatRateBpToPercentText(bp: number): string {
	const whole = Math.trunc(bp / 100);
	const frac = bp % 100;
	if (frac === 0) return String(whole);
	return `${whole},${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}
