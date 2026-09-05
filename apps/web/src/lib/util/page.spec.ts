import { describe, expect, it } from 'vitest';
import { parsePageParam, pastLastPage } from './page.ts';

describe('parsePageParam', () => {
	it('accepts safe positive integers only', () => {
		expect(parsePageParam('3')).toBe(3);
		expect(parsePageParam(null)).toBe(1);
		expect(parsePageParam('')).toBe(1);
		expect(parsePageParam('1.5')).toBe(1);
		expect(parsePageParam('abc')).toBe(1);
		expect(parsePageParam('0')).toBe(1);
		expect(parsePageParam('-3')).toBe(1);
		expect(parsePageParam('1e400')).toBe(1);
		expect(parsePageParam(String(Number.MAX_SAFE_INTEGER + 2))).toBe(1);
	});
});

describe('pastLastPage', () => {
	it('page 1 always exists; anything past pageCount does not', () => {
		expect(pastLastPage(1, 0)).toBe(false);
		expect(pastLastPage(2, 0)).toBe(true);
		expect(pastLastPage(3, 3)).toBe(false);
		expect(pastLastPage(4, 3)).toBe(true);
	});
});
