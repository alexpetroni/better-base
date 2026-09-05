import { describe, expect, it } from 'vitest';
import { withMigrateLock } from './migrate-lock.ts';

/**
 * FIX-16 (audit "Migration contract"): nothing stopped a human's
 * `pnpm db:migrate` from running alongside CI's. The wrapper takes
 * `pg_advisory_lock(hashtext('better-base-migrate'))` on its own session for
 * the whole run, so two runs against one database serialize instead of
 * racing DDL — proven here by actually racing them.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('withMigrateLock', () => {
	it('serializes two concurrent runs: the second body starts after the first body ends', async () => {
		const events: string[] = [];
		const first = withMigrateLock(url, async () => {
			events.push('first:start');
			await sleep(300);
			events.push('first:end');
			return 'a';
		});
		// Give the first run a head start so it holds the lock when the second asks.
		await sleep(50);
		const second = withMigrateLock(url, async () => {
			events.push('second:start');
			events.push('second:end');
			return 'b';
		});
		expect(await Promise.all([first, second])).toEqual(['a', 'b']);
		expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
	});

	it('releases the lock when the body throws, so the next run is not stuck', async () => {
		await expect(
			withMigrateLock(url, async () => {
				throw new Error('migration failed');
			})
		).rejects.toThrow('migration failed');
		await expect(withMigrateLock(url, async () => 'after')).resolves.toBe('after');
	});
});
