import {
	neonConfig,
	Pool as NeonPool,
	type PoolClient as NeonPoolClient
} from '@neondatabase/serverless';
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
 * Local Neon-protocol stack (dev/tests, never production): when NEON_WS_PROXY
 * is set to a `host:port`, the driver dials that WebSocket proxy — the
 * compose `neon-proxy` service (`docker compose --profile neon up -d`), the
 * same wsproxy Neon runs in front of its own databases — instead of deriving
 * a wss:// endpoint from the connection-string host. This is what lets
 * `pnpm test:neon` exercise the real WebSocket transport against the local
 * Postgres. Against real Neon the variable stays unset and none of this runs.
 */
function configureLocalWsProxy(proxy: string): void {
	// The proxy sits on the compose network, so the Postgres address it dials
	// is the compose-internal one — NOT the host-published port from
	// DATABASE_URL (its allowlist admits only this value, see docker-compose.yml).
	const target = process.env.NEON_WS_PROXY_TARGET ?? 'db:5432';
	neonConfig.wsProxy = () => `${proxy}/v1?address=${target}`;
	// The local proxy listens on plain ws:// (no nginx TLS layer in front).
	neonConfig.useSecureWebSocket = false;
	// Connect pipelining needs cleartext password auth; compose Postgres uses
	// SCRAM, so the handshake has to run unpipelined.
	neonConfig.pipelineConnect = false;
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
	const localProxy = process.env.NEON_WS_PROXY;
	if (localProxy) configureLocalWsProxy(localProxy);
	const pool = new NeonPool({
		connectionString,
		max: config.max,
		connectionTimeoutMillis: config.connectionTimeoutMillis,
		idleTimeoutMillis: config.idleTimeoutMillis
	});
	pool.on('connect', (client: NeonPoolClient) => {
		// Not awaited, but safe: the pg protocol is strictly ordered per
		// connection, so this SET completes before any query the pool hands
		// this client afterwards. driver-parity.spec.ts proves it holds.
		void client.query(`SET statement_timeout = ${config.statementTimeoutMillis}`);
	});
	// Both drivers produce a PgDatabase over the same schema with the same
	// query API and a `$client` exposing `end()`, so every call site typed as
	// `Db` works against either. The generic parameters differ (NeonQueryResultHKT
	// vs NodePgQueryResultHKT), which is what this cast bridges — guarded by the
	// compile-time assertions below and the runtime surface check in
	// driver-parity.spec.ts, so it cannot rot silently.
	return neonDrizzle(pool) as unknown as Db;
}

/** Split out so the neon side's OWN type (pre-cast) exists to assert against. */
function neonDrizzle(pool: NeonPool) {
	return drizzleNeon(pool, { schema });
}
type NeonDb = ReturnType<typeof neonDrizzle>;

/**
 * Compile-time proof obligations for the `as unknown as Db` cast above. Full
 * mutual assignability is exactly what the differing HKT generics rule out;
 * what CAN be demanded is that the neon driver's own type still carries every
 * member `Db` promises (so no call site can reach a property that is not
 * there) and the `$client.end()` shutdown seam. If a drizzle or driver bump
 * drops or renames anything, these lines stop compiling.
 */
type MembersOfDbMissingFromNeonDb = Exclude<keyof Db, keyof NeonDb>;
true satisfies MembersOfDbMissingFromNeonDb extends never ? true : MembersOfDbMissingFromNeonDb;
true satisfies NeonDb['$client'] extends { end(): Promise<void> } ? true : never;
true satisfies NeonDb['transaction'] extends (...args: never[]) => Promise<unknown> ? true : never;

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
