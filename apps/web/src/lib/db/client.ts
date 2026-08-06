import { Pool as NeonPool, type PoolClient as NeonPoolClient } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { positiveIntEnv } from '../server/env.ts';
import * as schema from './schema/index.ts';

export type Db = ReturnType<typeof createPgDb>;

/**
 * Which Postgres driver to connect with.
 * - `pg` (default): a real connection pool. Correct for the long-lived
 *   adapter-node server next to docker compose or on a VPS.
 * - `neon`: Neon's serverless driver over WebSockets, for short-lived
 *   functions (Vercel) where a classic pool would churn connections.
 *   WebSockets — not Neon's HTTP driver — because `db.transaction()` is used
 *   by blog/shop/gdpr services and HTTP cannot hold an interactive transaction.
 */
export const DB_DRIVERS = ['pg', 'neon'] as const;
export type DbDriver = (typeof DB_DRIVERS)[number];

export function isDbDriver(value: string): value is DbDriver {
	return (DB_DRIVERS as readonly string[]).includes(value);
}

/** Resolve the driver from env. An unknown value is a startup error, not a silent fallback. */
export function dbDriverFromEnv(env: Record<string, string | undefined> = process.env): DbDriver {
	const raw = env.DB_DRIVER;
	if (!raw) return 'pg';
	if (!isDbDriver(raw)) {
		throw new Error(`Unknown DB_DRIVER "${raw}" — expected one of: ${DB_DRIVERS.join(', ')}`);
	}
	return raw;
}

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

/**
 * Upper bound for the `neon` driver: each serverless function instance serves
 * one request at a time, so a bigger pool only multiplies idle connections
 * against Neon's per-project limit.
 */
export const NEON_POOL_MAX_DEFAULT = 1;

/** Resolve the pool config from env vars, with the documented defaults. */
export function poolConfigFromEnv(
	env: Record<string, string | undefined> = process.env,
	driver: DbDriver = 'pg'
): DbPoolConfig {
	const maxDefault = driver === 'neon' ? NEON_POOL_MAX_DEFAULT : DB_POOL_DEFAULTS.max;
	return {
		max: positiveIntEnv(env.DB_POOL_MAX, maxDefault),
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

/** The `pg` pool path: a real, long-lived connection pool. */
function createPgDb(connectionString: string, config: DbPoolConfig) {
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

/**
 * The Neon serverless path (WebSockets, so transactions still work).
 *
 * Two deliberate differences from the `pg` path:
 * - `statement_timeout` is applied with a `SET` on each new connection rather
 *   than in the startup packet: Neon's pooled endpoint runs PgBouncer, which
 *   rejects startup parameters it does not allowlist.
 * - the pool is tiny by default (see NEON_POOL_MAX_DEFAULT).
 */
function createNeonDb(connectionString: string, config: DbPoolConfig): Db {
	const pool = new NeonPool({
		connectionString,
		max: config.max,
		connectionTimeoutMillis: config.connectionTimeoutMillis,
		idleTimeoutMillis: config.idleTimeoutMillis
	});
	pool.on('connect', (client: NeonPoolClient) => {
		void client.query(`SET statement_timeout = ${config.statementTimeoutMillis}`);
	});
	// Both drivers produce a PgDatabase over the same schema with the same
	// query API and a `$client` exposing `end()`, so every call site typed as
	// `Db` works against either. The generic parameters differ (NeonQueryResultHKT
	// vs NodePgQueryResultHKT), which is what this cast bridges.
	return drizzleNeon(pool, { schema }) as unknown as Db;
}

/**
 * Create a Drizzle client for an explicit connection string (scripts, tests).
 * The driver defaults to `DB_DRIVER` from the environment — see `dbDriverFromEnv`.
 */
export function createDb(
	connectionString: string,
	config?: DbPoolConfig,
	driver: DbDriver = dbDriverFromEnv()
): Db {
	const resolved = config ?? poolConfigFromEnv(process.env, driver);
	return driver === 'neon'
		? createNeonDb(connectionString, resolved)
		: createPgDb(connectionString, resolved);
}
