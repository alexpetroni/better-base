import { describe, expect, it, vi } from 'vitest';

/**
 * FIX-16 (audit "Health & logs"): /api/health is LIVENESS — "the process is
 * up and serving" — and must answer 200 with no I/O at all. Both dependency
 * singletons throwing here proves it never touches them: readiness (db +
 * storage) lives at /api/health/ready, so an S3 blip cannot drain a site
 * that could still serve every page.
 */
vi.mock('$lib/db', () => ({
	getDb: () => {
		throw new Error('must not be called by liveness');
	}
}));
vi.mock('$lib/modules/media/server', () => ({
	getStorage: () => {
		throw new Error('must not be called by liveness');
	}
}));

// The chat barrel selects the provider from env at import: unset = mock.
vi.mock('$env/dynamic/private', () => ({ env: { SITE_ID: 'sleep' } }));

import { GET } from './+server.ts';

describe('GET /api/health (liveness)', () => {
	it('answers 200 without touching the database or storage', async () => {
		const response = await GET({} as Parameters<typeof GET>[0]);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = await response.json();
		expect(body).toEqual({
			status: 'ok',
			site: 'sleep',
			commit: expect.any(String),
			chatProvider: 'mock'
		});
		// The commit is the build's git sha (vite define) — never empty.
		expect(body.commit.length).toBeGreaterThan(0);
	});
});
