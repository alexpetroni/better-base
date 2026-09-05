import { describe, expect, it } from 'vitest';
import { formatRequestLog, requestLogEnabled, resolveRequestId } from './request-id.ts';

describe('resolveRequestId', () => {
	const VERCEL_ID = 'fra1::iad1::abcde-1725000000000-0123456789ab';

	it('adopts the x-vercel-id Vercel stamps on every function invocation — on Vercel', () => {
		const headers = new Headers({ 'x-vercel-id': VERCEL_ID });
		expect(resolveRequestId(headers, () => 'unused', { onVercel: true })).toBe(VERCEL_ID);
	});

	it('mints a UUID elsewhere (adapter-node has no platform id)', () => {
		expect(resolveRequestId(new Headers(), () => 'generated-id', { onVercel: false })).toBe(
			'generated-id'
		);
		expect(resolveRequestId(new Headers(), undefined, { onVercel: false })).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
		);
		expect(resolveRequestId(new Headers(), () => 'generated-id', { onVercel: true })).toBe(
			'generated-id'
		);
	});

	it('ignores a client-supplied x-request-id (an attacker must not choose our correlation key)', () => {
		const headers = new Headers({ 'x-request-id': 'spoofed' });
		expect(resolveRequestId(headers, () => 'generated-id', { onVercel: false })).toBe(
			'generated-id'
		);
		expect(resolveRequestId(headers, () => 'generated-id', { onVercel: true })).toBe(
			'generated-id'
		);
	});

	// FIX-17 (FIX-16 review, medium): off Vercel nobody but the client sets
	// x-vercel-id, so adopting it there let any caller choose the key the
	// request log, the error line and the error page show.
	it('ignores a client-supplied x-vercel-id on adapter-node (only the platform may stamp it)', () => {
		const headers = new Headers({ 'x-vercel-id': 'spoofed' });
		expect(resolveRequestId(headers, () => 'generated-id', { onVercel: false })).toBe(
			'generated-id'
		);
		expect(resolveRequestId(headers, () => 'generated-id', { onVercel: true })).toBe('spoofed');
	});

	it('on Vercel, an over-long or non-token x-vercel-id falls back to the UUID', () => {
		const tooLong = new Headers({ 'x-vercel-id': 'a'.repeat(129) });
		expect(resolveRequestId(tooLong, () => 'generated-id', { onVercel: true })).toBe(
			'generated-id'
		);
		const nonToken = new Headers({ 'x-vercel-id': 'fra1::abc <script>' });
		expect(resolveRequestId(nonToken, () => 'generated-id', { onVercel: true })).toBe(
			'generated-id'
		);
		const maxLength = new Headers({ 'x-vercel-id': 'a'.repeat(128) });
		expect(resolveRequestId(maxLength, () => 'generated-id', { onVercel: true })).toBe(
			'a'.repeat(128)
		);
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
