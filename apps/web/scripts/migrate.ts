// `pnpm db:migrate` — THE way to apply the schema (FIX-16, docs/MIGRATIONS.md):
//   1. take the migration advisory lock on a dedicated session (a human's
//      run and CI's serialize instead of racing DDL);
//   2. `drizzle-kit migrate` — every pending apps/web/drizzle/*.sql, in one
//      transaction, exactly as before;
//   3. the concurrent indexes (scripts/migrate-concurrent.ts) — `CREATE
//      INDEX CONCURRENTLY IF NOT EXISTS`, one autocommit statement each,
//      which the drizzle transaction cannot do.
// Prefers DIRECT_DATABASE_URL like drizzle.config.ts (Neon's pooled endpoint
// runs PgBouncer; DDL and session locks need the unpooled host).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { loadRootEnv } from './env.ts';
import { applyConcurrentIndexes } from '../src/lib/db/concurrent-indexes.ts';
import { withMigrateLock } from '../src/lib/db/migrate-lock.ts';

loadRootEnv();

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
	console.error('DIRECT_DATABASE_URL (or DATABASE_URL) is not set');
	process.exit(1);
}

const webDir = path.resolve(import.meta.dirname, '..');
const drizzleKit = path.join(webDir, 'node_modules', '.bin', 'drizzle-kit');

await withMigrateLock(
	url,
	async () => {
		// drizzle.config.ts reads the same env this process loaded.
		execFileSync(drizzleKit, ['migrate'], { cwd: webDir, stdio: 'inherit', env: process.env });
		const indexes = await applyConcurrentIndexes(url);
		for (const index of indexes) {
			console.log(`${index.created ? 'created' : 'present'}  ${index.name} (concurrent)`);
		}
	},
	() => console.log('db:migrate — lock acquired (better-base-migrate)')
);
console.log('db:migrate — done');
