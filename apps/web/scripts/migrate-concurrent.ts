// `pnpm db:migrate:concurrent` — apply only the CONCURRENT indexes declared
// in src/lib/db/concurrent-indexes.ts (`pnpm db:migrate` already runs this
// step after the SQL files; use this alone to retry after a failed build).
// Idempotent; takes the same advisory lock as db:migrate. See
// docs/MIGRATIONS.md.
import { loadRootEnv } from './env.ts';
import { applyConcurrentIndexes } from '../src/lib/db/concurrent-indexes.ts';
import { withMigrateLock } from '../src/lib/db/migrate-lock.ts';

loadRootEnv();

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
	console.error('DIRECT_DATABASE_URL (or DATABASE_URL) is not set');
	process.exit(1);
}

const indexes = await withMigrateLock(url, () => applyConcurrentIndexes(url));
for (const index of indexes) {
	console.log(`${index.created ? 'created' : 'present'}  ${index.name} (concurrent)`);
}
console.log(`db:migrate:concurrent — ${indexes.length} index(es) current`);
