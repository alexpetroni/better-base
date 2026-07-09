import { describe, expect, it } from 'vitest';
import { formatDate } from './date.ts';

describe('formatDate', () => {
	// 22:30 UTC = 00:30 next day in Europe/Bucharest (UTC+2, winter): the
	// timezone pin must flip the calendar day regardless of the runner's TZ.
	const late = new Date('2026-01-15T22:30:00Z');

	it('pins Europe/Bucharest so the day never depends on the server TZ', () => {
		expect(formatDate(late)).toBe('16 ian. 2026');
		expect(formatDate(late, 'long')).toBe('16 ianuarie 2026');
	});

	it('renders the time styles used by the admin', () => {
		expect(formatDate(late, 'medium-time')).toBe('16 ian. 2026, 00:30');
		expect(formatDate(late, 'long-time')).toBe('16 ianuarie 2026 la 00:30');
	});

	it('handles DST (summer = UTC+3)', () => {
		expect(formatDate(new Date('2026-07-15T21:30:00Z'), 'medium-time')).toBe('16 iul. 2026, 00:30');
	});
});
