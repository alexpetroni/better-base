/**
 * VAT math in integer bani. Prices in this shop are consumer prices and
 * INCLUDE VAT (that is what Stripe charged), so VAT is EXTRACTED from the
 * gross amount, never added on top: for a rate of `r` basis points,
 * `vat = gross * r / (10000 + r)`, rounded half-up to the ban.
 *
 * Rounding rule: PER LINE, half-up, totals are plain sums of the lines. This
 * is what Romanian invoicing practice expects (Ordinul 2634/2015 requires the
 * per-line VAT amount on the printed document, and per-line rounding is what
 * common RO invoicing software does): every printed line is internally
 * consistent and the totals equal the sum of the printed lines, so the
 * document adds up for the person reading it. The alternative — rounding once
 * on the invoice total — can differ by a ban or two from the sum of the
 * printed lines; vat.spec.ts pins a case where the two rules disagree.
 *
 * All inputs and outputs are integers; there is no float arithmetic anywhere.
 * Storno lines are NEVER recomputed: they negate the original line's stored
 * amounts, so the reversal is exact by construction (see service.ts).
 */

export interface VatLineInput {
	/** Units sold; positive at issuance. */
	qty: number;
	/** Gross unit price in bani (VAT included). */
	unitPriceCents: number;
	/** VAT rate in basis points; 0 for a VAT-unregistered issuer. */
	vatRateBp: number;
}

export interface VatAmounts {
	netCents: number;
	vatCents: number;
	grossCents: number;
}

function assertNonNegativeInt(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative integer, got ${value}`);
	}
}

/**
 * Integer division `num / den` rounded half-up. Written as
 * `floor((2*num + den) / (2*den))` so the .5 case rounds up exactly, with no
 * float division involved for any realistic invoice amount.
 */
function divRoundHalfUp(num: number, den: number): number {
	return Math.floor((2 * num + den) / (2 * den));
}

/** VAT contained in a gross amount, rounded half-up to the ban. */
export function extractVatFromGross(grossCents: number, vatRateBp: number): number {
	assertNonNegativeInt(grossCents, 'grossCents');
	assertNonNegativeInt(vatRateBp, 'vatRateBp');
	if (grossCents === 0 || vatRateBp === 0) return 0;
	return divRoundHalfUp(grossCents * vatRateBp, 10_000 + vatRateBp);
}

/** One line's amounts: gross = qty × unit price, VAT extracted, net = rest. */
export function computeLineAmounts(line: VatLineInput): VatAmounts {
	assertNonNegativeInt(line.qty, 'qty');
	assertNonNegativeInt(line.unitPriceCents, 'unitPriceCents');
	const grossCents = line.qty * line.unitPriceCents;
	const vatCents = extractVatFromGross(grossCents, line.vatRateBp);
	return { netCents: grossCents - vatCents, vatCents, grossCents };
}

/** Invoice totals: the sums of the (already-rounded) line amounts. */
export function sumAmounts(lines: VatAmounts[]): VatAmounts {
	return lines.reduce(
		(acc, line) => ({
			netCents: acc.netCents + line.netCents,
			vatCents: acc.vatCents + line.vatCents,
			grossCents: acc.grossCents + line.grossCents
		}),
		{ netCents: 0, vatCents: 0, grossCents: 0 }
	);
}
