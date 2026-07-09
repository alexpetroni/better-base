import { describe, expect, it } from 'vitest';
import { formatCents, parseLeiToCents } from './money.ts';

describe('parseLeiToCents', () => {
	it('parses whole lei, comma and dot decimals', () => {
		expect(parseLeiToCents('49')).toBe(4900);
		expect(parseLeiToCents('49,90')).toBe(4990);
		expect(parseLeiToCents('49.90')).toBe(4990);
		expect(parseLeiToCents(' 49,9 ')).toBe(4990);
		expect(parseLeiToCents('0,05')).toBe(5);
		expect(parseLeiToCents('0')).toBe(0);
	});

	it('rejects anything that is not a plain positive amount', () => {
		expect(parseLeiToCents('')).toBeNull();
		expect(parseLeiToCents('-5')).toBeNull();
		expect(parseLeiToCents('1.234,56')).toBeNull();
		expect(parseLeiToCents('49,999')).toBeNull();
		expect(parseLeiToCents('abc')).toBeNull();
		expect(parseLeiToCents('12,')).toBeNull();
		expect(parseLeiToCents('1e3')).toBeNull();
	});

	it('round-trips through formatCents', () => {
		expect(formatCents(parseLeiToCents('49,90')!)).toBe('49,90 lei');
	});
});

describe('formatCents', () => {
	it('formats bani as lei with two decimals', () => {
		expect(formatCents(4990)).toBe('49,90 lei');
		expect(formatCents(100)).toBe('1,00 lei');
		expect(formatCents(5)).toBe('0,05 lei');
		expect(formatCents(0)).toBe('0,00 lei');
		expect(formatCents(123456789)).toBe('1234567,89 lei');
	});

	it('handles negative amounts and other currencies', () => {
		expect(formatCents(-4990)).toBe('-49,90 lei');
		expect(formatCents(4990, 'eur')).toBe('49,90 EUR');
	});
});
