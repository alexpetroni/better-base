// Backfill `media.blurhash` for image rows that predate confirm-time encoding
// (`pnpm media:blurhash`). Idempotent and resumable: only rows still at null
// are touched, each is written as soon as it is computed, and failures are
// reported and skipped so a re-run retries exactly what is still missing.
// Needs DATABASE_URL plus the IMGPROXY_*/S3_BUCKET vars (the tiny renders come
// from imgproxy, same as every page view).
// Keep imports relative with explicit .ts extensions.
import { loadRootEnv } from './env.ts';
import { createDb } from '../src/lib/db/client.ts';
import { imgproxyConfigFromEnv } from '../src/lib/modules/media/env.ts';
import { backfillBlurhashes } from '../src/lib/modules/media/service.ts';

loadRootEnv();

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is not set — configure the root .env');
	process.exit(1);
}
const imgproxy = imgproxyConfigFromEnv(process.env);
if (!imgproxy.baseUrl || !imgproxy.key || !imgproxy.salt || !imgproxy.bucket) {
	console.error('IMGPROXY_URL/IMGPROXY_KEY/IMGPROXY_SALT/S3_BUCKET are not all set');
	process.exit(1);
}

const db = createDb(url);
try {
	const { filled, failed } = await backfillBlurhashes({ db, imgproxy }, { log: console.warn });
	console.log(`media:blurhash — filled ${filled}, failed ${failed}`);
	// A failing row stays null and is retried next run; exit nonzero so the
	// operator notices instead of assuming every row now has a placeholder.
	if (failed > 0) process.exit(1);
} finally {
	await db.$client.end();
}
