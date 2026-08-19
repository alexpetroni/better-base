// Backfill `media.blurhash` for image rows that predate confirm-time encoding
// (`pnpm media:blurhash`). Idempotent and resumable: only rows still at null
// are touched, each is written as soon as it is computed, and failures are
// reported and skipped so a re-run retries exactly what is still missing.
// Needs DATABASE_URL plus a TRANSFORMING image provider (IMAGE_PROVIDER=
// cloudflare or imgproxy): the tiny renders come from the same resize pipeline
// every page view uses, so `direct` — the local default — cannot serve them.
// Keep imports relative with explicit .ts extensions.
import { loadRootEnv } from './env.ts';
import { createDb } from '../src/lib/db/client.ts';
import { imageProviderFromEnv } from '../src/lib/modules/media/env.ts';
import { backfillBlurhashes } from '../src/lib/modules/media/service.ts';

loadRootEnv();

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is not set — configure the root .env');
	process.exit(1);
}

let images;
try {
	images = imageProviderFromEnv(process.env);
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}
if (!images.transforms) {
	console.error(
		`IMAGE_PROVIDER=${images.name} serves originals untouched — blurhashes need ` +
			'a transforming provider (cloudflare or imgproxy). Point this run at the ' +
			"deployed environment's env instead."
	);
	process.exit(1);
}

const db = createDb(url);
try {
	const { filled, failed } = await backfillBlurhashes({ db, images }, { log: console.warn });
	console.log(`media:blurhash — filled ${filled}, failed ${failed}`);
	// A failing row stays null and is retried next run; exit nonzero so the
	// operator notices instead of assuming every row now has a placeholder.
	if (failed > 0) process.exit(1);
} finally {
	await db.$client.end();
}
