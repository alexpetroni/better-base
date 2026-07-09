import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { positiveIntEnv } from '../server/env.ts';
import * as schema from './schema/index.ts';

export type Db = ReturnType<typeof createDb>;

/**
 * Pool bounds and timeouts (audit Theme C): without them a few hung requests
 * hold connections forever and starve everything, including /api/health.
 * All values are overridable via env — see `.env.example`.
 */
export interface DbPoolConfig {
	/** Upper bound on open connections. */
	max: number;
	/** How long a checkout waits for a connection before failing (shed load, don't queue forever). */
	connectionTimeoutMillis: number;
	/** Idle connections are closed after this. */
	idleTimeoutMillis: number;
	/** Server-side `statement_timeout` set per connection: no query may run longer. */
	statementTimeoutMillis: number;
}

export const DB_POOL_DEFAULTS: DbPoolConfig = {
	max: 10,
	connectionTimeoutMillis: 5_000,
	idleTimeoutMillis: 30_000,
	statementTimeoutMillis: 30_000
};

/** Resolve the pool config from env vars, with the documented defaults. */
export function poolConfigFromEnv(
	env: Record<string, string | undefined> = process.env
): DbPoolConfig {
	return {
		max: positiveIntEnv(env.DB_POOL_MAX, DB_POOL_DEFAULTS.max),
		connectionTimeoutMillis: positiveIntEnv(
			env.DB_POOL_CONNECTION_TIMEOUT_MS,
			DB_POOL_DEFAULTS.connectionTimeoutMillis
		),
		idleTimeoutMillis: positiveIntEnv(
			env.DB_POOL_IDLE_TIMEOUT_MS,
			DB_POOL_DEFAULTS.idleTimeoutMillis
		),
		statementTimeoutMillis: positiveIntEnv(
			env.DB_STATEMENT_TIMEOUT_MS,
			DB_POOL_DEFAULTS.statementTimeoutMillis
		)
	};
}

/** Create a Drizzle client for an explicit connection string (scripts, tests). */
export function createDb(connectionString: string, config: DbPoolConfig = poolConfigFromEnv()) {
	const pool = new pg.Pool({
		connectionString,
		max: config.max,
		connectionTimeoutMillis: config.connectionTimeoutMillis,
		idleTimeoutMillis: config.idleTimeoutMillis,
		// Sent in the startup packet, so Postgres itself cancels runaway queries.
		statement_timeout: config.statementTimeoutMillis
	});
	return drizzle(pool, { schema });
}
