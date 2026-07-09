import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '$lib/db/client';
import { storageConfigFromEnv } from '../modules/media/env.ts';
import { createStorage } from '../modules/media/storage.ts';
import { checkHealth } from './health.ts';

// Integration against the compose stack: the same checks /api/health runs,
// pointed at good and deliberately broken endpoints (DoD: dependency down →
// degraded report → the endpoint answers 503).

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
const storageCfg = storageConfigFromEnv(process.env);

const goodDb = createDb(url);
// Port 9 (discard) refuses immediately — the "database container down" case.
const badDb = createDb('postgres://better:better@host.docker.internal:9/void');
const goodStorage = createStorage(storageCfg);
const badStorage = createStorage({ ...storageCfg, endpoint: 'http://host.docker.internal:9' });
const missingBucket = createStorage({ ...storageCfg, bucket: 'no-such-bucket-health-spec' });

afterAll(async () => {
	await goodDb.$client.end();
	await badDb.$client.end();
});

describe('checkHealth', () => {
	it('reports healthy when db and storage are reachable', async () => {
		await goodStorage.ensureBucket();
		expect(await checkHealth({ db: goodDb, storage: goodStorage })).toEqual({
			healthy: true,
			checks: { db: 'ok', storage: 'ok' }
		});
	});

	it('degrades when the database is unreachable', async () => {
		const report = await checkHealth({ db: badDb, storage: goodStorage });
		expect(report).toEqual({ healthy: false, checks: { db: 'error', storage: 'ok' } });
	});

	it('degrades when storage is unreachable or the bucket is missing', async () => {
		expect(await checkHealth({ db: goodDb, storage: badStorage })).toEqual({
			healthy: false,
			checks: { db: 'ok', storage: 'error' }
		});
		expect(await checkHealth({ db: goodDb, storage: missingBucket })).toEqual({
			healthy: false,
			checks: { db: 'ok', storage: 'error' }
		});
	});

	it('treats a hung dependency as an error instead of hanging', async () => {
		const hung = { headBucket: () => new Promise<void>(() => {}) };
		const report = await checkHealth({ db: goodDb, storage: hung }, 50);
		expect(report.checks.storage).toBe('error');
	});
});
