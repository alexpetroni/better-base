import { describe, expect, it } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
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

	// Audit 2026-09-03 "Ops & platform": drizzle's DrizzleQueryError message is
	// `Failed query: <sql>\nparams: <params>` — the params are the row values
	// (chat text, addresses, CUIs, emails, password hashes). They must never
	// reach the log drain; the query text (no values) keeps the line useful.
	it('strips the params block of a DrizzleQueryError from message AND stack', () => {
		const err = new DrizzleQueryError(
			'insert into "subscribers" ("email", "name") values ($1, $2)',
			['ana.popescu@example.com', 'Ana Popescu'],
			new Error('duplicate key value violates unique constraint')
		);
		const line = formatServerError({ ...base, error: err });
		expect(line).not.toContain('params:');
		expect(line).not.toContain('ana.popescu@example.com');
		expect(line).not.toContain('Ana Popescu');
		const parsed = JSON.parse(line);
		expect(parsed.message).toBe(
			'Failed query: insert into "subscribers" ("email", "name") values ($1, $2)'
		);
		expect(parsed.stack).toContain('Failed query: insert into "subscribers"');
	});

	it('carries the request id so a log line and a response can be matched', () => {
		const parsed = JSON.parse(
			formatServerError({ ...base, error: new Error('boom'), requestId: 'fra1::abc-1234' })
		);
		expect(parsed.requestId).toBe('fra1::abc-1234');
	});
});
