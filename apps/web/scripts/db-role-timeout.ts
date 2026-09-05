// `pnpm db:role-timeout [--timeout=30s]` — pin `statement_timeout` on the
// role the app connects as (FIX-16, DEPLOYMENT.md §12 deploy order).
//
// Why: on Neon the pooled endpoint runs PgBouncer, where the app's
// per-connection `SET statement_timeout` is not a session guarantee. An
// `ALTER ROLE … SET` is inherited by every connection the role opens, pooled
// or not. The script only alters CURRENT_USER — the role of the URL it runs
// with — and is idempotent, so it is safe to re-run on every deploy. Prefers
// DIRECT_DATABASE_URL like the migrator (role DDL through the pooler works,
// but the unpooled endpoint is the one the deploy order already exports).
import { loadRootEnv } from './env.ts';
import { createDb } from '../src/lib/db/client.ts';
import { roleStatementTimeout, setRoleStatementTimeout } from '../src/lib/db/role-timeout.ts';

loadRootEnv();

let timeout = '30s';
for (const arg of process.argv.slice(2)) {
	if (arg === '--') continue;
	if (arg.startsWith('--timeout=')) {
		timeout = arg.slice('--timeout='.length);
		continue;
	}
	console.error(
		`db:role-timeout — unknown argument "${arg}"\nUsage: pnpm db:role-timeout [--timeout=30s]`
	);
	process.exit(2);
}

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
	console.error('DIRECT_DATABASE_URL (or DATABASE_URL) is not set');
	process.exit(1);
}

const db = createDb(url);
try {
	await setRoleStatementTimeout(db, timeout);
	const after = await roleStatementTimeout(db);
	console.log(
		`db:role-timeout — role ${after.role}: statement_timeout = ${after.statementTimeout}`
	);
} finally {
	await db.$client.end();
}
