/**
 * Romanian CUI (cod unic de înregistrare / cod de identificare fiscală).
 *
 * Shape: 2–10 digits, optionally prefixed with `RO` — the prefix is the VAT
 * registration marker, NOT part of the number. The last digit is a control
 * digit: the digits before it are left-padded with zeros to 9 positions,
 * multiplied position-wise by the key `753192753`, the sum is multiplied by
 * 10 and reduced mod 11, and a result of 10 counts as 0. A shape-only check
 * (audit 2026-09-03 P1) accepted every fixture CUI with a wrong control
 * digit; issuance, the settings validator and the B2B checkout form all use
 * `isValidCui` now.
 *
 * Shared by the settings registry (issuer identification), the invoice
 * service (snapshot form) and the checkout's B2B buyer capture; kept in
 * $lib/util because the e2e helpers import shop/checkout.ts outside Vite.
 */

/** Shape only (no checksum): 2–10 digits with an optional RO prefix. */
export const CUI_PATTERN = /^(RO)?\d{2,10}$/i;

const CONTROL_KEY = [7, 5, 3, 1, 9, 2, 7, 5, 3];

/** The trimmed, uppercased input split into prefix flag + digits; null when not CUI-shaped. */
export function normalizeCui(input: string): { digits: string; prefixed: boolean } | null {
	const trimmed = input.trim();
	if (!CUI_PATTERN.test(trimmed)) return null;
	const prefixed = /^ro/i.test(trimmed);
	return { digits: prefixed ? trimmed.slice(2) : trimmed, prefixed };
}

/** The mod-11 control digit for the digits BEFORE the control position. */
function controlDigit(base: string): number {
	const padded = base.padStart(9, '0');
	let sum = 0;
	for (let i = 0; i < 9; i++) sum += Number(padded[i]) * CONTROL_KEY[i];
	const control = (sum * 10) % 11;
	return control === 10 ? 0 : control;
}

/** Shape AND checksum: what the settings validator, issuance and the B2B form accept. */
export function isValidCui(input: string): boolean {
	const normalized = normalizeCui(input);
	if (!normalized) return false;
	const { digits } = normalized;
	return controlDigit(digits.slice(0, -1)) === Number(digits.at(-1));
}

/**
 * Display / snapshot form: uppercase, and the `RO` prefix present EXACTLY
 * when the entity is VAT-registered (the prefix IS the registration marker
 * in Romania). Used by the footer, the legal pages and the invoice snapshot.
 */
export function displayCui(cui: string, vatRegistered: boolean): string {
	const bare = cui.trim().replace(/^ro/i, '');
	return vatRegistered ? `RO${bare}` : bare;
}

/**
 * Does the stored CUI's prefix contradict the registration flag? A prefixed
 * CUI on a `neplătitor` claims a VAT registration the entity lacks; a bare
 * CUI on a registered entity denies one it has — either way the invoice
 * would misstate the issuer, so issuance and launch:check refuse it. Values
 * that are not CUI-shaped at all are somebody else's problem (reported as
 * invalid/placeholder), never a mismatch.
 */
export function cuiPrefixMismatch(cui: string, vatRegistered: boolean): boolean {
	const normalized = normalizeCui(cui);
	if (!normalized) return false;
	return normalized.prefixed !== vatRegistered;
}
