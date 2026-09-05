import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyNeonStatementTimeout } from './client.ts';

/**
 * FIX-16 (audit "Neon path edges"): the on-connect `SET statement_timeout`
 * used to be `void`-ed — a rejection (PgBouncer refusing the SET, a dropped
 * socket) became an unhandled rejection that kills the function instance.
 * It must resolve either way and leave one warn line when it fails.
 */
describe('applyNeonStatementTimeout', () => {
	afterEach(() => vi.restoreAllMocks());

	it('issues the SET with the configured timeout', async () => {
		const query = vi.fn(async () => ({}));
		await applyNeonStatementTimeout({ query }, 12_000);
		expect(query).toHaveBeenCalledWith('SET statement_timeout = 12000');
	});

	it('never rejects — a failed SET is one warn line, not a dead instance', async () => {
		const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
		const query = vi.fn(async () => {
			throw new Error('server closed the connection unexpectedly');
		});
		await expect(applyNeonStatementTimeout({ query }, 30_000)).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		const line = JSON.parse(String(warn.mock.calls[0][0]));
		expect(line.level).toBe('warn');
		expect(line.message).toContain('statement_timeout');
		expect(line.message).toContain('server closed the connection unexpectedly');
	});
});
