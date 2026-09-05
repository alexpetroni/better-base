/**
 * IBAN checksum (ISO 13616, mod 97-10). The issuer's IBAN is printed on
 * every invoice and PDF and carried as the e-Factura
 * `PayeeFinancialAccount/ID`, so the settings field validates it (FIX-18,
 * review 2026-09-05 #6) the way `company.cui` validates its control digit.
 *
 * Shape: two letters (country), two check digits, then 11–30 alphanumerics
 * (15–34 characters in all). Spaces are accepted anywhere and case is
 * ignored: `normalizeIban` is the stored/printed form (upper case, no
 * spaces). Kept in $lib/util like `cui.ts` — framework-free and shared by the
 * settings registry and any future form that captures a bank account.
 */

const IBAN_SHAPE = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;

/** Upper case, every whitespace removed — the canonical (electronic) form. */
export function normalizeIban(input: string): string {
	return input.replace(/\s+/g, '').toUpperCase();
}

/**
 * Shape AND checksum: move the first four characters to the end, map letters
 * to 10…35, and the number must be ≡ 1 (mod 97). Computed incrementally so no
 * 30-digit integer is ever built.
 */
export function ibanMod97(input: string): boolean {
	const iban = normalizeIban(input);
	if (!IBAN_SHAPE.test(iban)) return false;
	const rearranged = iban.slice(4) + iban.slice(0, 4);
	let remainder = 0;
	for (const char of rearranged) {
		const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
		for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
	}
	return remainder === 1;
}
