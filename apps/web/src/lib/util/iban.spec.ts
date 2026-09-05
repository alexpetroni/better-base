import { describe, expect, it } from 'vitest';
import { ibanMod97, normalizeIban } from './iban.ts';

// FIX-18 (review 2026-09-05 #6): the IBAN is printed on every invoice, PDF and
// e-Factura PayeeFinancialAccount, and the settings field had no checksum.
describe('ibanMod97 (ISO 13616)', () => {
	it('accepts the canonical Romanian example', () => {
		expect(ibanMod97('RO49AAAA1B31007593840000')).toBe(true);
	});

	it('refuses a transposed-digit variant and a wrong check pair', () => {
		expect(ibanMod97('RO49AAAA1B31007593480000')).toBe(false);
		expect(ibanMod97('RO94AAAA1B31007593840000')).toBe(false);
	});

	it('normalises lower case and inner spaces before checking', () => {
		expect(ibanMod97('ro49 aaaa 1b31 0075 9384 0000')).toBe(true);
		expect(normalizeIban(' ro49 aaaa 1b31 0075 9384 0000 ')).toBe('RO49AAAA1B31007593840000');
	});

	it('refuses shapes that are not an IBAN at all', () => {
		expect(ibanMod97('')).toBe(false);
		expect(ibanMod97('RO49')).toBe(false);
		expect(ibanMod97('RO49-AAAA-1B31-0075-9384-0000')).toBe(false);
		expect(ibanMod97('1249AAAA1B31007593840000')).toBe(false);
		expect(ibanMod97('RO49AAAA1B31007593840000AAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
	});

	it('accepts other countries too (the checksum is not RO-specific)', () => {
		expect(ibanMod97('DE89 3704 0044 0532 0130 00')).toBe(true);
		expect(ibanMod97('GB82 WEST 1234 5698 7654 32')).toBe(true);
	});
});
