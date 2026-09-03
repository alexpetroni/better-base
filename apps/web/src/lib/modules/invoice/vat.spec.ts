import { describe, expect, it } from 'vitest';
import {
	computeLineAmounts,
	extractVatFromGross,
	partialStornoLineAmounts,
	sumAmounts
} from './vat.ts';

// Pure integer VAT math: extraction from gross, half-up, PER LINE (the
// documented rule — see README). The table pins boundary cases including odd
// bani, the exact-.5 tie, the 0% unregistered case, and one where per-line
// and per-total rounding genuinely disagree.

describe('extractVatFromGross', () => {
	it.each([
		// [gross, rateBp, vat] — vat = gross·r/(10000+r), half-up
		[12100, 2100, 2100], // exact: 121,00 lei at 21% contains 21,00 VAT
		[4990, 2100, 866], // 866.03 → 866 (down)
		[32, 2100, 6], // 5.553 → 6 (up)
		[1, 2100, 0], // 0.17 → 0: a 1-ban line still balances
		[2997, 2100, 520], // 520.14 → 520
		[3, 2000, 1], // EXACT .5 tie (0.5) → 1: half-up, not half-even
		[9999999900, 2100, 1735537173], // ~100M lei: still exact integer math
		[4990, 0, 0], // 0% (neplătitor de TVA)
		[0, 2100, 0]
	])('gross %i at %i bp → %i bani VAT', (gross, rate, vat) => {
		expect(extractVatFromGross(gross, rate)).toBe(vat);
	});

	it('rejects non-integer and negative inputs — money is integer bani only', () => {
		expect(() => extractVatFromGross(49.9, 2100)).toThrow(/integer/);
		expect(() => extractVatFromGross(-1, 2100)).toThrow(/integer/);
		expect(() => extractVatFromGross(100, 21.5)).toThrow(/integer/);
	});
});

describe('computeLineAmounts', () => {
	it('gross = qty × unit price; net + vat always reassemble the gross', () => {
		const line = computeLineAmounts({ qty: 3, unitPriceCents: 999, vatRateBp: 2100 });
		expect(line).toEqual({ grossCents: 2997, vatCents: 520, netCents: 2477 });
		expect(line.netCents + line.vatCents).toBe(line.grossCents);
	});

	it('0% rate (VAT-unregistered issuer): net equals gross, zero VAT', () => {
		expect(computeLineAmounts({ qty: 2, unitPriceCents: 4990, vatRateBp: 0 })).toEqual({
			grossCents: 9980,
			vatCents: 0,
			netCents: 9980
		});
	});

	it('rejects negative or fractional qty — stornos negate stored amounts instead', () => {
		expect(() => computeLineAmounts({ qty: -1, unitPriceCents: 100, vatRateBp: 2100 })).toThrow();
		expect(() => computeLineAmounts({ qty: 1.5, unitPriceCents: 100, vatRateBp: 2100 })).toThrow();
	});
});

describe('per-line rounding (the documented rule)', () => {
	it('two 0,32-lei lines at 21%: per-line VAT is 12 bani where total-rounding would say 11', () => {
		const lines = [
			computeLineAmounts({ qty: 1, unitPriceCents: 32, vatRateBp: 2100 }),
			computeLineAmounts({ qty: 1, unitPriceCents: 32, vatRateBp: 2100 })
		];
		const totals = sumAmounts(lines);
		// Each line rounds 5.553 up to 6; the totals are the SUM of the lines…
		expect(totals).toEqual({ grossCents: 64, vatCents: 12, netCents: 52 });
		// …whereas rounding once on the invoice total would give a DIFFERENT
		// number (11) that no combination of printed lines could explain.
		expect(extractVatFromGross(64, 2100)).toBe(11);
	});

	it('totals are plain sums of already-rounded lines', () => {
		const lines = [
			computeLineAmounts({ qty: 2, unitPriceCents: 4990, vatRateBp: 2100 }),
			computeLineAmounts({ qty: 1, unitPriceCents: 12550, vatRateBp: 2100 })
		];
		expect(sumAmounts(lines)).toEqual({
			grossCents: 22530,
			vatCents: 1732 + 2178,
			netCents: 8248 + 10372
		});
		expect(sumAmounts([])).toEqual({ grossCents: 0, vatCents: 0, netCents: 0 });
	});
});

describe('partialStornoLineAmounts (a storno for a refunded amount, not for lines)', () => {
	it('splits the refunded gross into net + VAT at the original line rate, negated, in integer bani', () => {
		// 49,90 lei refunded out of a 21% invoice: VAT contained = 866, net 4124.
		expect(partialStornoLineAmounts(4990, 2100)).toEqual({
			grossCents: -4990,
			vatCents: -866,
			netCents: -4124
		});
		// The negated parts reassemble the negated gross exactly.
		const line = partialStornoLineAmounts(2997, 2100);
		expect(line.netCents + line.vatCents).toBe(line.grossCents);
		expect(line).toEqual({ grossCents: -2997, vatCents: -520, netCents: -2477 });
	});

	it('uses the same half-up extraction as issuance: the .5 tie rounds up, 0% has no VAT', () => {
		expect(partialStornoLineAmounts(3, 2000)).toEqual({
			grossCents: -3,
			vatCents: -1,
			netCents: -2
		});
		expect(partialStornoLineAmounts(4990, 0)).toEqual({
			grossCents: -4990,
			vatCents: 0,
			netCents: -4990
		});
	});

	it('refuses a non-positive or non-integer amount — a storno reverses money, never nothing', () => {
		expect(() => partialStornoLineAmounts(0, 2100)).toThrow(/positive/);
		expect(() => partialStornoLineAmounts(-100, 2100)).toThrow(/positive/);
		expect(() => partialStornoLineAmounts(49.9, 2100)).toThrow(/integer/);
	});
});
