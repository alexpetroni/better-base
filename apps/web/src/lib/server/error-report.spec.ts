import { afterEach, describe, expect, it, vi } from 'vitest';
import { postErrorReport } from './error-report.ts';

describe('postErrorReport (ERROR_REPORT_URL sink)', () => {
	afterEach(() => vi.restoreAllMocks());

	it('posts the log line as JSON to the sink', async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
		const line = JSON.stringify({ level: 'error', message: 'boom' });
		await postErrorReport('https://sink.example.com/ingest', line, fetchImpl);
		expect(fetchImpl).toHaveBeenCalledWith('https://sink.example.com/ingest', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: line
		});
	});

	it('never rejects — a refused or unreachable sink becomes one warn line on stderr', async () => {
		const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(
			postErrorReport(
				'https://sink.example.com',
				'{}',
				async () => new Response(null, { status: 401 })
			)
		).resolves.toBeUndefined();
		await expect(
			postErrorReport('https://sink.example.com', '{}', async () => {
				throw new Error('ECONNREFUSED');
			})
		).resolves.toBeUndefined();
		const lines = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
		expect(lines.map((entry) => entry.level)).toEqual(['warn', 'warn']);
		expect(lines[0].message).toContain('401');
		expect(lines[1].message).toContain('ECONNREFUSED');
	});
});
