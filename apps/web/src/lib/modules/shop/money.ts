/**
 * Money is integer cents (bani) everywhere — DB, services, Stripe. These
 * helpers are the ONLY place amounts meet human-readable strings, and they
 * work on integer/string math only: no float arithmetic on money.
 */

/**
 * Parse an admin-entered price like "49,90", "49.90" or "49" into bani.
 * Returns null for anything that is not a plain positive amount with at most
 * two decimals (no thousands separators, no signs — reject rather than guess).
 */
export function parseLeiToCents(input: string): number | null {
	const match = /^(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(input.trim());
	if (!match) return null;
	const lei = Number(match[1]);
	const bani = Number((match[2] ?? '').padEnd(2, '0') || '0');
	return lei * 100 + bani;
}

/** Format bani for display: 4990 → "49,90 lei" (other currencies: "49,90 EUR"). */
export function formatCents(cents: number, currency = 'ron'): string {
	const sign = cents < 0 ? '-' : '';
	const abs = Math.abs(cents);
	const whole = Math.trunc(abs / 100);
	const frac = String(abs % 100).padStart(2, '0');
	const unit = currency.toLowerCase() === 'ron' ? 'lei' : currency.toUpperCase();
	return `${sign}${whole},${frac} ${unit}`;
}
