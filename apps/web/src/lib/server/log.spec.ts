import { describe, expect, it } from 'vitest';
import { formatServerError } from './log.ts';

describe('formatServerError', () => {
	const base = {
		errorId: 'abc-123',
		status: 500,
		method: 'GET',
		path: '/blog',
		message: 'Internal Error',
		now: new Date('2026-07-09T12:00:00Z')
	};

	it('emits one parseable JSON line with all fields', () => {
		const line = formatServerError({ ...base, error: new Error('db exploded') });
		expect(line).not.toContain('\n');
		expect(JSON.parse(line)).toMatchObject({
			ts: '2026-07-09T12:00:00.000Z',
			level: 'error',
			errorId: 'abc-123',
			status: 500,
			method: 'GET',
			path: '/blog',
			message: 'db exploded'
		});
		expect(JSON.parse(line).stack).toContain('db exploded');
	});

	it('falls back to the framework message for non-Error throws', () => {
		const parsed = JSON.parse(formatServerError({ ...base, error: 'boom' }));
		expect(parsed.message).toBe('Internal Error');
		expect(parsed.stack).toBeUndefined();
	});

	it('redacts capability tokens from logged paths (audit L2)', () => {
		const token = 'eyJzdWIiOiJzLTEifQ.c2lnbmF0dXJl';
		for (const path of [`/newsletter/confirm/${token}`, `/unsubscribe/${token}`]) {
			const line = formatServerError({ ...base, path, error: new Error('boom') });
			expect(line).not.toContain(token);
			expect(JSON.parse(line).path).toMatch(/\[redacted\]$/);
		}
		// Non-token paths stay verbatim — greppability matters.
		const parsed = JSON.parse(
			formatServerError({ ...base, path: '/blog/un-articol', error: new Error('x') })
		);
		expect(parsed.path).toBe('/blog/un-articol');
	});
});
