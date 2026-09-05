import pg from 'pg';

/**
 * Migration mutex (FIX-16, audit "Migration contract"): a session-level
 * advisory lock held for the whole `db:migrate` run, so CI and a human — or
 * two CI runs on two sites' workflows pointed at one database by mistake —
 * serialize instead of racing DDL. Keyed on a fixed text so every caller
 * agrees without a shared table; session-scoped so a crashed run releases it
 * when its connection drops.
 *
 * A plain `pg.Client` on purpose: advisory locks live on the SESSION, which
 * a pooled/PgBouncer connection does not guarantee — pass the DIRECT
 * (unpooled) URL, as the migrator itself requires.
 */
export const MIGRATE_LOCK_NAME = 'better-base-migrate';

/** How long a run waits for another run to finish before giving up. */
export const MIGRATE_LOCK_WAIT_MS = 10 * 60_000;
const POLL_MS = 250;

/**
 * Polled `pg_try_advisory_lock`, NOT a blocking `pg_advisory_lock`: the
 * blocking form is a running statement that holds a snapshot for as long as
 * it waits, and the holder's `CREATE INDEX CONCURRENTLY` waits for every
 * older snapshot to go away — two runs would deadlock undetected (the
 * migrate-script spec races them). Each poll is its own short statement.
 */
export async function withMigrateLock<T>(
	connectionString: string,
	body: () => Promise<T>,
	onAcquired: () => void = () => {},
	waitMs: number = MIGRATE_LOCK_WAIT_MS
): Promise<T> {
	const client = new pg.Client({ connectionString });
	await client.connect();
	try {
		const deadline = Date.now() + waitMs;
		for (;;) {
			const result = await client.query<{ locked: boolean }>(
				'select pg_try_advisory_lock(hashtext($1)) as locked',
				[MIGRATE_LOCK_NAME]
			);
			if (result.rows[0].locked) break;
			if (Date.now() >= deadline) {
				throw new Error(
					`another migration run has held the ${MIGRATE_LOCK_NAME} lock for over ${waitMs} ms — is a db:migrate stuck?`
				);
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		}
		onAcquired();
		try {
			return await body();
		} finally {
			await client.query('select pg_advisory_unlock(hashtext($1))', [MIGRATE_LOCK_NAME]);
		}
	} finally {
		await client.end();
	}
}
