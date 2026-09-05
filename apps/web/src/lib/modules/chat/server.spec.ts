import { afterEach, describe, expect, it, vi } from 'vitest';

// FIX-14 (audit P2): a mock provider in production was undetectable — the
// barrel now says which provider it selected, once, when it boots.
vi.mock('$env/dynamic/private', () => ({ env: {} }));

describe('chat server barrel boot line', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it('logs `chat provider: <kind>` exactly once at boot', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.resetModules();
		const barrel = await import('./server.ts');
		expect(barrel.getChatProvider().kind).toBe('mock');
		barrel.getChatProvider();
		const lines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('chat provider:'));
		expect(lines).toEqual(['chat provider: mock']);
	});
});
