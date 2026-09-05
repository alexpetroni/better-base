// Operator re-queue of e-Factura submissions parked after EFACTURA_MAX_ATTEMPTS
// (FIX-17): back to `pending`, attempts reset, so the next `efactura-submit`
// tick claims them again while the 5-day statutory clock is still running.
// The same write the admin order page's "Repune în coada ANAF" button does.
// Usage: pnpm efactura:requeue -- --all
//        pnpm efactura:requeue -- <invoiceId>
import { parseArgs } from 'node:util';
import { loadRootEnv } from './env.ts';
import { createDb } from '../src/lib/db/client.ts';
import {
	requeueAllParkedSubmissions,
	requeueParkedSubmission
} from '../src/lib/modules/invoice/submissions.ts';

loadRootEnv();

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
const { values, positionals } = parseArgs({
	args,
	options: { all: { type: 'boolean', default: false } },
	allowPositionals: true
});
const [invoiceId] = positionals;
if ((values.all && invoiceId) || (!values.all && !invoiceId) || positionals.length > 1) {
	console.error('Usage: pnpm efactura:requeue -- --all | <invoiceId>');
	process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is not set — configure the root .env');
	process.exit(1);
}

const db = createDb(url);
try {
	if (values.all) {
		const count = await requeueAllParkedSubmissions({ db });
		console.log(`efactura:requeue — ${count} parked submission(s) back in the queue`);
	} else {
		const found = await requeueParkedSubmission({ db }, invoiceId);
		if (!found) {
			console.error(`efactura:requeue — no parked (failed) submission for invoice ${invoiceId}`);
			process.exitCode = 1;
		} else {
			console.log(`efactura:requeue — invoice ${invoiceId} back in the queue`);
		}
	}
} finally {
	await db.$client.end();
}
