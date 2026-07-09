import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { sql } from 'drizzle-orm';
import { createDb, DB_POOL_DEFAULTS, poolConfigFromEnv } from './client.ts';

/** Drizzle wraps query errors; the pg error text lives in the cause chain. */
async function rejectionText(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (err) {
		const parts: string[] = [];
		for (let e: unknown = err; e instanceof Error; e = e.cause) parts.push(e.message);
		return parts.join(' | ');
	}
	throw new Error('expected the promise to reject');
}

// Audit Theme C (resilience #2): the pool must be bounded and every wait must
// have a deadline — before the fix `new pg.Pool({ connectionString })` used
// pg's wait-forever default, so a few hung requests starved everything,
// including /api/health.

describe('poolConfigFromEnv', () => {
	it('falls back to the documented defaults when env is unset', () => {
		expect(poolConfigFromEnv({})).toEqual(DB_POOL_DEFAULTS);
	});

	it('reads overrides from env', () => {
		expect(
			poolConfigFromEnv({
				DB_POOL_MAX: '3',
				DB_POOL_CONNECTION_TIMEOUT_MS: '111',
				DB_POOL_IDLE_TIMEOUT_MS: '222',
				DB_STATEMENT_TIMEOUT_MS: '333'
			})
		).toEqual({
			max: 3,
			connectionTimeoutMillis: 111,
			idleTimeoutMillis: 222,
			statementTimeoutMillis: 333
		});
	});

	it('ignores garbage and non-positive values', () => {
		expect(
			poolConfigFromEnv({
				DB_POOL_MAX: 'lots',
				DB_POOL_CONNECTION_TIMEOUT_MS: '-5',
				DB_POOL_IDLE_TIMEOUT_MS: '',
				DB_STATEMENT_TIMEOUT_MS: '1.5'
			})
		).toEqual(DB_POOL_DEFAULTS);
	});
});

describe('createDb pool limits', () => {
	it('constructs the pg pool with the configured limits', async () => {
		// Never queried — nothing connects to this address.
		const db = createDb('postgres://better:better@127.0.0.1:9/never-connected', {
			max: 3,
			connectionTimeoutMillis: 123,
			idleTimeoutMillis: 456,
			statementTimeoutMillis: 789
		});
		try {
			expect(db.$client.options.max).toBe(3);
			expect(db.$client.options.connectionTimeoutMillis).toBe(123);
			expect(db.$client.options.idleTimeoutMillis).toBe(456);
			expect(db.$client.options.statement_timeout).toBe(789);
		} finally {
			await db.$client.end();
		}
	});

	it('applies the env-derived defaults when no explicit config is passed', async () => {
		const db = createDb('postgres://better:better@127.0.0.1:9/never-connected');
		try {
			expect(db.$client.options.max).toBe(DB_POOL_DEFAULTS.max);
			expect(db.$client.options.connectionTimeoutMillis).toBe(
				DB_POOL_DEFAULTS.connectionTimeoutMillis
			);
			expect(db.$client.options.statement_timeout).toBe(DB_POOL_DEFAULTS.statementTimeoutMillis);
		} finally {
			await db.$client.end();
		}
	});

	it('fails within the connection timeout against a server that never completes the handshake (hung before the fix)', async () => {
		// A TCP server that accepts and then stays silent: the socket connects,
		// the Postgres handshake never answers — what a hung DB looks like.
		const server = net.createServer(() => {});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as net.AddressInfo;
		const db = createDb(`postgres://better:better@127.0.0.1:${port}/x`, {
			...DB_POOL_DEFAULTS,
			connectionTimeoutMillis: 300
		});
		try {
			expect(await rejectionText(db.execute(sql`select 1`))).toMatch(/timeout/i);
		} finally {
			await db.$client.end();
			server.close();
		}
	}, 5_000);

	it('cancels runaway queries via the server-side statement timeout (integration)', async () => {
		const url = process.env.TEST_DATABASE_URL;
		if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
		const db = createDb(url, { ...DB_POOL_DEFAULTS, statementTimeoutMillis: 100 });
		try {
			expect(await rejectionText(db.execute(sql`select pg_sleep(2)`))).toMatch(
				/statement timeout/i
			);
		} finally {
			await db.$client.end();
		}
	});
});
