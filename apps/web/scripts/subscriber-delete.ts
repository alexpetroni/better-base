// GDPR data-deletion CLI: erases a subscriber and anonymizes their traces.
// Usage: pnpm subscriber:delete -- --email person@example.com
import { config } from 'dotenv';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createDb } from '../src/lib/db/client.ts';
import { eraseSubscriberData } from '../src/lib/modules/gdpr/erase.ts';

config({ path: path.resolve(import.meta.dirname, '../../../.env') });

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const { values } = parseArgs({ args, options: { email: { type: 'string' } } });

if (!values.email) {
	console.error('Usage: pnpm subscriber:delete -- --email <email>');
	process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const db = createDb(databaseUrl);
try {
	const result = await eraseSubscriberData({ db }, values.email);
	if (!result.ok) {
		console.error(`Invalid email address: ${values.email}`);
		process.exit(1);
	}
	const s = result.value;
	console.log(
		`Subscriber ${s.subscriberDeleted ? 'deleted' : 'not found (nothing to delete)'}; ` +
			`quiz results unlinked: ${s.quizResultsUnlinked}; orders anonymized: ${s.ordersAnonymized}; ` +
			`email log entries anonymized: ${s.emailLogAnonymized}`
	);
} finally {
	await db.$client.end();
}
