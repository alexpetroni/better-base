import { describe, expect, it, vi } from 'vitest';

// Missing env makes both singleton constructors throw — exactly what the old
// route turned into a 500 with a stack (audit resilience #9).
vi.mock('$lib/db', () => ({
	getDb: () => {
		throw new Error('DATABASE_URL is not set');
	}
}));
vi.mock('$lib/modules/media/server', () => ({
	getStorage: () => {
		throw new Error('Missing media env vars: S3_ENDPOINT');
	}
}));

// The chat barrel selects the provider from env at import: unset = mock.
vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { GET } from './+server.ts';

describe('GET /api/health with unconstructable dependencies', () => {
	it('answers 503 with a structured body instead of throwing a 500', async () => {
		const response = await GET({} as Parameters<typeof GET>[0]);
		expect(response.status).toBe(503);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({
			status: 'degraded',
			checks: { db: 'error', storage: 'error' },
			chatProvider: 'mock'
		});
	});

	// FIX-14 (audit P2): the provider kind is visible to ops, not only to tests.
	it('carries the chat provider kind', async () => {
		const response = await GET({} as Parameters<typeof GET>[0]);
		expect((await response.json()).chatProvider).toBe('mock');
	});
});
