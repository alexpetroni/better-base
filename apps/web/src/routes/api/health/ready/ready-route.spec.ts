import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '$lib/db/client';

/**
 * FIX-16: /api/health/ready is READINESS — today's db + storage checks — and
 * the one a load balancer or uptime monitor should alert on. Integration
 * against the compose stack: a real database with storage pointed at a
 * refusing port must produce 503, not 200 and not a 500.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');

const holder = vi.hoisted(() => ({
	mode: 'unreachable-storage' as 'unreachable-storage' | 'unconstructable'
}));

vi.mock('$lib/db', async () => {
	const { createDb: create } = await import('$lib/db/client');
	return {
		getDb: () => {
			if (holder.mode === 'unconstructable') throw new Error('DATABASE_URL is not set');
			return db;
		},
		create
	};
});
vi.mock('$lib/modules/media/server', async () => {
	const { createStorage: create } = await import('$lib/modules/media/storage');
	const { storageConfigFromEnv: fromEnv } = await import('$lib/modules/media/env');
	return {
		getStorage: () => {
			if (holder.mode === 'unconstructable') throw new Error('Missing media env vars: S3_ENDPOINT');
			return create({
				...fromEnv(process.env),
				// Port 9 (discard) refuses immediately — "object storage down".
				endpoint: 'http://host.docker.internal:9'
			});
		}
	};
});
vi.mock('$env/dynamic/private', () => ({ env: { SITE_ID: 'sleep' } }));

const db = createDb(url);

import { GET } from './+server.ts';

afterAll(async () => {
	await db.$client.end();
});

describe('GET /api/health/ready (readiness)', () => {
	it('answers 503 when storage is unreachable while the database is fine', async () => {
		holder.mode = 'unreachable-storage';
		const response = await GET({} as Parameters<typeof GET>[0]);
		expect(response.status).toBe(503);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({
			status: 'degraded',
			checks: { db: 'ok', storage: 'error' },
			chatProvider: 'mock'
		});
	});

	// Missing env makes both singleton constructors throw — the old route
	// turned that into a 500 with a stack (audit resilience #9).
	it('answers 503 with a structured body when a dependency cannot be constructed', async () => {
		holder.mode = 'unconstructable';
		const response = await GET({} as Parameters<typeof GET>[0]);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			status: 'degraded',
			checks: { db: 'error', storage: 'error' },
			chatProvider: 'mock'
		});
	});
});
