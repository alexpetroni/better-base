import { describe, expect, it } from 'vitest';
import { cuiPrefixMismatch, displayCui, isValidCui, normalizeCui } from './cui.ts';

// The Romanian CUI carries a mod-11 control digit (key 753192753 applied to
// the left-zero-padded 9 digits before it; ×10 mod 11, 10 ⇒ 0). A shape-only
// check let every spec fixture through with a WRONG control digit (audit
// 2026-09-03 P1 "CUI is shape-only"); this matrix pins the real rule.

describe('isValidCui', () => {
	it.each([
		// [input, valid]
		['12345676', true], // 1234567 → control 6
		['RO12345676', true], // the VAT prefix is not part of the checksum
		['ro12345676', true], // any case
		[' RO12345676 ', true], // trimmed
		['999885', true], // 99988 → 5
		['18', true], // the shortest CUI: one digit + control (1 → 8)
		['1234567896', true], // ten digits
		['24681354', true],
		['12345678', false], // the historical fixture: control should be 6
		['RO12345678', false],
		['999888', false],
		['1234567890', false],
		['1', false], // too short to carry a control digit
		['12345678901', false], // too long
		['RO', false],
		['', false],
		['not-a-cui', false],
		['RO 1234 5676', false] // inner whitespace is not a CUI
	])('%s → %s', (input, valid) => {
		expect(isValidCui(input)).toBe(valid);
	});
});

describe('normalizeCui', () => {
	it('splits the prefix from the digits, uppercase, trimmed', () => {
		expect(normalizeCui(' ro12345676 ')).toEqual({ digits: '12345676', prefixed: true });
		expect(normalizeCui('12345676')).toEqual({ digits: '12345676', prefixed: false });
		expect(normalizeCui('abc')).toBeNull();
		expect(normalizeCui('RO')).toBeNull();
	});
});

describe('displayCui', () => {
	it('prefixes RO exactly when VAT-registered, never doubling it, always uppercase', () => {
		expect(displayCui('12345676', true)).toBe('RO12345676');
		expect(displayCui('RO12345676', true)).toBe('RO12345676');
		expect(displayCui('ro12345676', true)).toBe('RO12345676');
		expect(displayCui('12345676', false)).toBe('12345676');
		expect(displayCui('RO12345676', false)).toBe('12345676');
	});
});

describe('cuiPrefixMismatch', () => {
	// The RO prefix IS the VAT-registration marker: a stored CUI must state
	// it exactly as the entity's registration does, or the invoice would
	// claim (or deny) a registration the checkbox contradicts.
	it('flags a prefixed CUI on an unregistered issuer and a bare one on a registered issuer', () => {
		expect(cuiPrefixMismatch('RO12345676', false)).toBe(true);
		expect(cuiPrefixMismatch('12345676', true)).toBe(true);
		expect(cuiPrefixMismatch('RO12345676', true)).toBe(false);
		expect(cuiPrefixMismatch('12345676', false)).toBe(false);
	});

	it('is silent on values that are not a CUI at all (reported elsewhere)', () => {
		expect(cuiPrefixMismatch('', true)).toBe(false);
		expect(cuiPrefixMismatch('PLACEHOLDER — CUI', false)).toBe(false);
	});
});
