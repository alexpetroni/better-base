// Creates (or, idempotent on email, updates) a staff user.
// Usage: pnpm user:create -- --email you@example.com --role admin [--name …]
//   the password is PROMPTED (no echo) on a terminal, or piped:
//   printf '%s\n' "$PW" | pnpm user:create -- --email … --role admin --password-stdin
//   `--password <value>` is accepted only from a non-interactive caller and
//   refused on a terminal (shell history, `ps` — FIX-16).
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { loadRootEnv } from './env.ts';
import { createDb } from '../src/lib/db/client.ts';
import { createAuth } from '../src/lib/modules/auth/auth.ts';
import { isStaffRole } from '../src/lib/modules/auth/guards.ts';
import { upsertStaffUser } from '../src/lib/modules/auth/staff.ts';
import { resolvePasswordInput } from '../src/lib/server/password-input.ts';

loadRootEnv();

// pnpm forwards the user's `--` separator literally; drop it so parseArgs
// still sees the flags as options.
const args = process.argv.slice(2);
if (args[0] === '--') args.shift();

const { values } = parseArgs({
	args,
	options: {
		email: { type: 'string' },
		password: { type: 'string' },
		'password-stdin': { type: 'boolean' },
		role: { type: 'string' },
		name: { type: 'string' }
	}
});

const { email, role, name } = values;
if (!email || !role) {
	console.error(
		'Usage: pnpm user:create -- --email <email> --role <admin|editor> [--name <name>] [--password-stdin]'
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

async function readAllStdin(): Promise<string> {
	let data = '';
	for await (const chunk of process.stdin) data += chunk;
	return data;
}

/** Prompt without echo: readline with the output muted while typing. */
async function promptHidden(label: string): Promise<string> {
	process.stdout.write(label);
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: true
	});
	// Mute the echo: readline writes the typed characters through _writeToOutput.
	const muted = rl as unknown as { _writeToOutput: (s: string) => void };
	muted._writeToOutput = () => {};
	try {
		return await rl.question('');
	} finally {
		rl.close();
		process.stdout.write('\n');
	}
}

let password: string;
try {
	password = await resolvePasswordInput({
		password: values.password,
		passwordStdin: values['password-stdin'],
		isTTY: Boolean(process.stdin.isTTY),
		readStdin: readAllStdin,
		prompt: promptHidden
	});
} catch (err) {
	console.error(`user:create — ${err instanceof Error ? err.message : err}`);
	process.exit(1);
}

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
