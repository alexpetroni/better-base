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

/**
 * Plain decimal amount without a unit: 4990 → "49.90" (or "49,90"). Feeds the
 * machine-facing renderings — e-Factura XML amounts (dot) and the accountant
 * CSV export (comma, the Romanian Excel default). Integer math only.
 */
export function centsToDecimal(cents: number, decimalSeparator: '.' | ',' = '.'): string {
	const sign = cents < 0 ? '-' : '';
	const abs = Math.abs(cents);
	const whole = Math.trunc(abs / 100);
	const frac = String(abs % 100).padStart(2, '0');
	return `${sign}${whole}${decimalSeparator}${frac}`;
}

/**
 * Unit price with four decimals from a line total and quantity: (3333, 2) →
 * "16.6650". Four decimals because a per-line-rounded net total rarely divides
 * into whole bani; EN 16931 explicitly allows extra precision on unit prices.
 * Rounded half-up on the fourth decimal; integer math throughout.
 */
export function centsPerUnitToDecimal(
	totalCents: number,
	qty: number,
	decimalSeparator: '.' | ',' = '.'
): string {
	if (!Number.isInteger(qty) || qty === 0) throw new Error(`Invalid unit quantity: ${qty}`);
	const sign = totalCents < 0 !== qty < 0 && totalCents !== 0 ? '-' : '';
	// Scale to hundredths of a ban (4 decimals of a leu) before dividing.
	const scaled = Math.round((Math.abs(totalCents) * 100) / Math.abs(qty));
	const whole = Math.trunc(scaled / 10_000);
	const frac = String(scaled % 10_000).padStart(4, '0');
	return `${sign}${whole}${decimalSeparator}${frac}`;
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
