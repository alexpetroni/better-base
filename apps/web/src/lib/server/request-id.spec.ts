import { describe, expect, it } from 'vitest';
import { formatRequestLog, requestLogEnabled, resolveRequestId } from './request-id.ts';

describe('resolveRequestId', () => {
	it('adopts the x-vercel-id Vercel stamps on every function invocation', () => {
		const headers = new Headers({ 'x-vercel-id': 'fra1::iad1::abcde-1725000000000-0123456789ab' });
		expect(resolveRequestId(headers, () => 'unused')).toBe(
			'fra1::iad1::abcde-1725000000000-0123456789ab'
		);
	});

	it('mints a UUID elsewhere (adapter-node has no platform id)', () => {
		expect(resolveRequestId(new Headers(), () => 'generated-id')).toBe('generated-id');
		expect(resolveRequestId(new Headers())).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		);
	});

	it('ignores a client-supplied x-request-id (an attacker must not choose our correlation key)', () => {
		const headers = new Headers({ 'x-request-id': 'spoofed' });
		expect(resolveRequestId(headers, () => 'generated-id')).toBe('generated-id');
	});
});

describe('formatRequestLog', () => {
	it('emits one JSON line with method, redacted path, status, duration and request id', () => {
		const line = formatRequestLog({
			method: 'GET',
			path: '/unsubscribe/eyJzdWIiOiJzLTEifQ.c2ln',
			status: 200,
			durationMs: 12.4,
			requestId: 'req-1',
			now: new Date('2026-09-05T10:00:00Z')
		});
		expect(line).not.toContain('\n');
		expect(line).not.toContain('eyJzdWIiOiJzLTEifQ');
		expect(JSON.parse(line)).toEqual({
			ts: '2026-09-05T10:00:00.000Z',
			level: 'info',
			kind: 'request',
			method: 'GET',
			path: '/unsubscribe/[redacted]',
			status: 200,
			durationMs: 12,
			requestId: 'req-1'
		});
	});
});

describe('requestLogEnabled', () => {
	it('is on by default for adapter-node and off on Vercel (which logs requests itself)', () => {
		expect(requestLogEnabled({})).toBe(true);
		expect(requestLogEnabled({ VERCEL: '1' })).toBe(false);
	});

	it('LOG_REQUESTS overrides either default', () => {
		expect(requestLogEnabled({ LOG_REQUESTS: 'false' })).toBe(false);
		expect(requestLogEnabled({ VERCEL: '1', LOG_REQUESTS: 'true' })).toBe(true);
	});
});
