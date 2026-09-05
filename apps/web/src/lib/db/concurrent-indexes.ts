import pg from 'pg';

/**
 * Indexes built OUTSIDE the drizzle transaction (FIX-16, audit "Migration
 * contract"). drizzle-kit applies every pending file in one transaction,
 * where `CREATE INDEX CONCURRENTLY` is illegal; on a large table a plain
 * `CREATE INDEX` takes an exclusive lock for the whole build and stalls
 * every write. So indexes on tables that may already be big are declared
 * HERE and applied by `scripts/migrate-concurrent.ts` (which `db:migrate`
 * runs after the SQL files), each on its own autocommit statement.
 *
 * Contract (docs/MIGRATIONS.md): append only; `IF NOT EXISTS`; the name in
 * the statement matches `name`. Never also add the same index to a drizzle
 * migration file.
 */
export interface ConcurrentIndex {
	name: string;
	sql: string;
}

export const CONCURRENT_INDEXES: readonly ConcurrentIndex[] = [
	// `site_settings.updated_by` → users.id (ON DELETE SET NULL): the FK has no
	// index, so a staff-user delete scans the table (audit P2, FIX-16).
	{
		name: 'site_settings_updated_by_idx',
		sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS site_settings_updated_by_idx ON site_settings (updated_by)'
	}
];

async function indexValidity(client: pg.Client, name: string): Promise<boolean | null> {
	const result = await client.query<{ indisvalid: boolean }>(
		'select i.indisvalid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = $1',
		[name]
	);
	return result.rows[0]?.indisvalid ?? null;
}

/**
 * Apply every declared index; returns what happened per index. A concurrent
 * build that fails leaves an INVALID index behind, which `IF NOT EXISTS`
 * would then happily keep forever — so an invalid leftover is dropped and
 * rebuilt once, and still-invalid is an error, never a silent skip.
 */
export async function applyConcurrentIndexes(
	connectionString: string,
	indexes: readonly ConcurrentIndex[] = CONCURRENT_INDEXES
): Promise<Array<{ name: string; created: boolean }>> {
	const client = new pg.Client({ connectionString });
	await client.connect();
	const outcome: Array<{ name: string; created: boolean }> = [];
	try {
		for (const index of indexes) {
			let valid = await indexValidity(client, index.name);
			if (valid === false) {
				await client.query(`DROP INDEX IF EXISTS ${index.name}`);
				valid = null;
			}
			if (valid === true) {
				outcome.push({ name: index.name, created: false });
				continue;
			}
			// No transaction: CONCURRENTLY cannot run inside one, and pg.Client
			// autocommits each query outside an explicit BEGIN.
			await client.query(index.sql);
			if ((await indexValidity(client, index.name)) !== true) {
				throw new Error(
					`index ${index.name} is INVALID after CREATE INDEX CONCURRENTLY — drop it and re-run`
				);
			}
			outcome.push({ name: index.name, created: true });
		}
	} finally {
		await client.end();
	}
	return outcome;
}
