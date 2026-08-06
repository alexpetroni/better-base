import { describe, expect, it } from 'vitest';
import {
	DB_POOL_DEFAULTS,
	NEON_POOL_MAX_DEFAULT,
	dbDriverFromEnv,
	isDbDriver,
	poolConfigFromEnv
} from './client.ts';

// The driver seam that lets one codebase serve both deployment targets:
// `pg` for the long-lived adapter-node server, `neon` for serverless
// functions. See DEPLOYMENT.md.

describe('dbDriverFromEnv', () => {
	it('defaults to pg when DB_DRIVER is unset or empty', () => {
		expect(dbDriverFromEnv({})).toBe('pg');
		expect(dbDriverFromEnv({ DB_DRIVER: '' })).toBe('pg');
	});

	it('reads a known driver', () => {
		expect(dbDriverFromEnv({ DB_DRIVER: 'pg' })).toBe('pg');
		expect(dbDriverFromEnv({ DB_DRIVER: 'neon' })).toBe('neon');
	});

	it('throws on an unknown driver instead of silently falling back', () => {
		// A typo'd DB_DRIVER on a serverless deploy would otherwise open a real
		// pool per function instance and exhaust the database's connections.
		expect(() => dbDriverFromEnv({ DB_DRIVER: 'postgres' })).toThrow(/Unknown DB_DRIVER/);
	});

	it('recognizes valid driver names', () => {
		expect(isDbDriver('neon')).toBe(true);
		expect(isDbDriver('mysql')).toBe(false);
	});
});

describe('poolConfigFromEnv driver defaults', () => {
	it('keeps the documented pool size for pg', () => {
		expect(poolConfigFromEnv({}, 'pg').max).toBe(DB_POOL_DEFAULTS.max);
		expect(poolConfigFromEnv({})).toEqual(DB_POOL_DEFAULTS);
	});

	it('shrinks the pool to one connection for neon', () => {
		// One request per function instance: a larger pool only multiplies idle
		// connections against Neon's per-project limit.
		expect(poolConfigFromEnv({}, 'neon').max).toBe(NEON_POOL_MAX_DEFAULT);
	});

	it('lets DB_POOL_MAX override either default', () => {
		expect(poolConfigFromEnv({ DB_POOL_MAX: '5' }, 'neon').max).toBe(5);
		expect(poolConfigFromEnv({ DB_POOL_MAX: '5' }, 'pg').max).toBe(5);
	});

	it('leaves the timeouts driver-independent', () => {
		const neon = poolConfigFromEnv({}, 'neon');
		expect({
			connectionTimeoutMillis: neon.connectionTimeoutMillis,
			idleTimeoutMillis: neon.idleTimeoutMillis,
			statementTimeoutMillis: neon.statementTimeoutMillis
		}).toEqual({
			connectionTimeoutMillis: DB_POOL_DEFAULTS.connectionTimeoutMillis,
			idleTimeoutMillis: DB_POOL_DEFAULTS.idleTimeoutMillis,
			statementTimeoutMillis: DB_POOL_DEFAULTS.statementTimeoutMillis
		});
	});
});
