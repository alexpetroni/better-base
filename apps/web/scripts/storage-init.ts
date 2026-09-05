// Idempotent storage bootstrap: creates the media bucket if missing and makes
// it anonymously readable, which is what the `direct` provider needs to serve
// originals locally (in production R2's custom-domain binding does this);
// creates the PRIVATE fiscal bucket (invoice PDFs + e-Factura XML, FIX-12)
// and never opens it. Run via `pnpm storage:init` (after `docker compose up -d`).
import { loadRootEnv } from './env.ts';
import { createStorage } from '../src/lib/modules/media/storage.ts';
import { invoiceStorageConfigFromEnv, storageConfigFromEnv } from '../src/lib/modules/media/env.ts';

loadRootEnv();

const cfg = storageConfigFromEnv(process.env);
for (const [name, value] of Object.entries(cfg)) {
	if (!value) throw new Error(`Storage env var for "${name}" is not set — see .env.example`);
}

const storage = createStorage(cfg);
const outcome = await storage.ensureBucket();
console.log(`Bucket "${cfg.bucket}": ${outcome}`);

const fiscalCfg = invoiceStorageConfigFromEnv(process.env);
const fiscal = createStorage(fiscalCfg);
console.log(
	`Fiscal bucket "${fiscalCfg.bucket}": ${await fiscal.ensureBucket()} (private — no policy)`
);

// Not fatal: R2 rejects PutBucketPolicy (public access is a dashboard-side
// custom-domain binding there), and this script is also run against it.
try {
	await storage.allowPublicRead();
	console.log(`Bucket "${cfg.bucket}": public read policy applied`);
} catch (err) {
	console.warn(
		`Bucket "${cfg.bucket}": could not apply a public-read policy ` +
			`(${err instanceof Error ? err.message : String(err)}). ` +
			'Fine on R2 — bind a custom domain instead; on MinIO the `direct` provider will 403.'
	);
}
