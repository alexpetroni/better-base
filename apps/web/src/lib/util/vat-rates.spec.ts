import { describe, expect, it } from 'vitest';
import {
	formatVatRateSchedule,
	isAllowedVatRateBp,
	parseVatRateSchedule,
	RO_VAT_RATES_BP,
	standardVatRateAt,
	vatRateBpToPercentText
} from './vat-rates.ts';

// The standard VAT rate is an EFFECTIVE-DATED list (audit 2026-09-03 P1 "one
// global VAT rate, no effective dating"): the operator edits one line per
// rate change and issuance picks the rate in force on the ORDER date, so a
// retry after a rate change never invoices yesterday's order at today's rate.

describe('RO_VAT_RATES_BP allowlist', () => {
	it('contains the legal RO rates, in basis points, and never zero', () => {
		expect([...RO_VAT_RATES_BP]).toEqual([500, 900, 1100, 1900, 2100]);
		expect(isAllowedVatRateBp(2100)).toBe(true);
		expect(isAllowedVatRateBp(1100)).toBe(true);
		// A registered issuer with a 0 % line would emit category Z by accident
		// (audit P2 "VAT category holes") — zero is not a selectable rate.
		expect(isAllowedVatRateBp(0)).toBe(false);
		expect(isAllowedVatRateBp(2200)).toBe(false);
		expect(isAllowedVatRateBp(21)).toBe(false);
		expect(isAllowedVatRateBp('2100')).toBe(false);
	});
});

describe('parseVatRateSchedule', () => {
	it('parses one "YYYY-MM-DD percent" line per rate, sorted by date', () => {
		expect(parseVatRateSchedule('2025-08-01 21')).toEqual([{ from: '2025-08-01', bp: 2100 }]);
		expect(parseVatRateSchedule('2025-08-01: 21\n\n2017-01-01 = 19\n')).toEqual([
			{ from: '2017-01-01', bp: 1900 },
			{ from: '2025-08-01', bp: 2100 }
		]);
		// Fractional percents are integer basis points (never a float).
		expect(parseVatRateSchedule('2025-08-01 19,5')).toBeNull(); // not a legal RO rate
	});

	it('rejects empty, malformed, duplicate-date and non-allowlisted entries', () => {
		expect(parseVatRateSchedule('')).toBeNull();
		expect(parseVatRateSchedule('   \n ')).toBeNull();
		expect(parseVatRateSchedule('21')).toBeNull();
		expect(parseVatRateSchedule('2025-13-01 21')).toBeNull();
		expect(parseVatRateSchedule('2025-08-01 0')).toBeNull();
		expect(parseVatRateSchedule('2025-08-01 22')).toBeNull();
		expect(parseVatRateSchedule('2025-08-01 21\n2025-08-01 19')).toBeNull();
		expect(parseVatRateSchedule('2025-08-01 abc')).toBeNull();
	});

	it('round-trips through formatVatRateSchedule', () => {
		const text = formatVatRateSchedule([
			{ from: '2025-08-01', bp: 2100 },
			{ from: '2017-01-01', bp: 1900 }
		]);
		expect(text).toBe('2017-01-01 19\n2025-08-01 21');
		expect(parseVatRateSchedule(text)).toEqual([
			{ from: '2017-01-01', bp: 1900 },
			{ from: '2025-08-01', bp: 2100 }
		]);
	});
});

describe('standardVatRateAt', () => {
	const schedule = parseVatRateSchedule('2017-01-01 19\n2025-08-01 21')!;

	it('selects the latest entry in force on the given (Bucharest) day', () => {
		expect(standardVatRateAt(schedule, '2025-07-31')).toBe(1900);
		expect(standardVatRateAt(schedule, '2025-08-01')).toBe(2100);
		expect(standardVatRateAt(schedule, '2026-09-04')).toBe(2100);
	});

	it('falls back to the earliest entry before the schedule starts', () => {
		expect(standardVatRateAt(schedule, '2016-12-31')).toBe(1900);
	});
});

describe('vatRateBpToPercentText', () => {
	it('renders whole and fractional percents with a comma', () => {
		expect(vatRateBpToPercentText(2100)).toBe('21');
		expect(vatRateBpToPercentText(1950)).toBe('19,5');
		expect(vatRateBpToPercentText(525)).toBe('5,25');
	});
});
