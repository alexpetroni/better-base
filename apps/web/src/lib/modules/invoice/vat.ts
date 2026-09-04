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
 * Full-storno lines are NEVER recomputed: they negate the original line's
 * stored amounts, so the reversal is exact by construction (see service.ts).
 * A PARTIAL storno reverses an amount rather than lines, so its single line
 * extracts VAT from the refunded gross at the original rate
 * (`partialStornoLineAmounts`).
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

/**
 * The single line of a partial storno: the refunded gross (positive, bani)
 * split into net + VAT at the original invoice's rate with the same half-up
 * extraction as issuance, then negated — a storno reverses. A partial refund
 * is a customer-facing amount, not a set of lines, so this is the only place
 * a storno line is computed rather than copied.
 */
export function partialStornoLineAmounts(grossCents: number, vatRateBp: number): VatAmounts {
	if (!Number.isInteger(grossCents)) {
		throw new Error(`grossCents must be an integer, got ${grossCents}`);
	}
	if (grossCents <= 0) {
		throw new Error(`a partial storno must reverse a positive amount, got ${grossCents}`);
	}
	const vatCents = extractVatFromGross(grossCents, vatRateBp);
	// `0 - x` rather than `-x`: a 0% rate must yield 0, not -0.
	return {
		netCents: 0 - (grossCents - vatCents),
		vatCents: 0 - vatCents,
		grossCents: 0 - grossCents
	};
}

export interface GrossShare<K> {
	key: K;
	amountCents: number;
}

/**
 * Split an amount across groups in proportion to each group's gross, in
 * integer bani, with the largest-remainder method: every group gets the
 * floor of its exact share, and the leftover bani go one each to the groups
 * with the largest fractional parts, so the shares sum to EXACTLY the
 * amount. Used for a partial storno of a multi-rate invoice — a refund is
 * money, not lines, so each VAT rate present on the original reverses its
 * proportional part at its own rate. Groups whose share is zero are dropped.
 */
export function splitAmountByGross<K>(
	amountCents: number,
	groups: Array<{ key: K; grossCents: number }>
): GrossShare<K>[] {
	if (!Number.isInteger(amountCents) || amountCents <= 0) {
		throw new Error(`amountCents must be a positive integer, got ${amountCents}`);
	}
	const total = groups.reduce((sum, group) => sum + group.grossCents, 0);
	if (amountCents > total) {
		throw new Error(`amount ${amountCents} exceeds the groups' gross ${total}`);
	}
	// Exact share = amount × gross / total; floor + remainder in integers.
	const shares = groups.map((group) => {
		const scaled = amountCents * group.grossCents;
		return {
			key: group.key,
			amountCents: Math.floor(scaled / total),
			remainder: scaled % total
		};
	});
	let leftover = amountCents - shares.reduce((sum, share) => sum + share.amountCents, 0);
	// Stable: ties keep the original group order (the invoice's line order).
	const byRemainder = shares
		.map((share, index) => ({ share, index }))
		.sort((a, b) => b.share.remainder - a.share.remainder || a.index - b.index);
	for (const { share } of byRemainder) {
		if (leftover === 0) break;
		share.amountCents += 1;
		leftover -= 1;
	}
	return shares
		.filter((share) => share.amountCents > 0)
		.map(({ key, amountCents: cents }) => ({ key, amountCents: cents }));
}
