// Creates (or, idempotent on email, updates) a staff user.
// Usage: pnpm user:create -- --email you@example.com --password 'min12chars!' --role admin
import { config } from 'dotenv';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createDb } from '../src/lib/db/client.ts';
import { createAuth } from '../src/lib/modules/auth/auth.ts';
import { isStaffRole } from '../src/lib/modules/auth/guards.ts';
import { upsertStaffUser } from '../src/lib/modules/auth/staff.ts';

config({ path: path.resolve(import.meta.dirname, '../../../.env') });

// pnpm forwards the user's `--` separator literally; drop it so parseArgs
// still sees the flags as options.
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

const { values } = parseArgs({
	args,
	options: {
		email: { type: 'string' },
		password: { type: 'string' },
		role: { type: 'string' },
		name: { type: 'string' }
	}
});

const { email, password, role, name } = values;
if (!email || !password || !role) {
	console.error(
		'Usage: pnpm user:create -- --email <email> --password <min 12 chars> --role <admin|editor> [--name <name>]'
	);
	process.exit(1);
}
if (!isStaffRole(role)) {
	console.error(`Invalid --role "${role}" — expected admin or editor`);
	process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) throw new Error('BETTER_AUTH_SECRET is not set');

const db = createDb(databaseUrl);
try {
	const auth = createAuth({ db, secret, baseURL: process.env.PUBLIC_SITE_URL });
	const result = await upsertStaffUser(auth, { email, password, role, name });
	console.log(
		`${result.status === 'created' ? 'Created' : 'Updated'} ${result.role} user ${result.email} (${result.userId})`
	);
} finally {
	await db.$client.end();
}
