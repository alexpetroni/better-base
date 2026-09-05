// Move fiscal documents out of the media bucket (FIX-12, audit P0 #4): every
// object under `invoices/` in S3_BUCKET goes to the private fiscal bucket
// (S3_INVOICE_BUCKET, default `<S3_BUCKET>-fiscal`). Idempotent — run it
// once per deploy that ever issued an invoice before FIX-12, or any number of
// times. Run via `pnpm storage:fiscal-migrate` (DEPLOYMENT.md §5).
import { loadRootEnv } from './env.ts';
import { invoiceStorageConfigFromEnv, storageConfigFromEnv } from '../src/lib/modules/media/env.ts';
import { createStorage } from '../src/lib/modules/media/storage.ts';
import { migrateFiscalObjects } from '../src/lib/modules/invoice/fiscal-storage.ts';

loadRootEnv();

const mediaCfg = storageConfigFromEnv(process.env);
const fiscalCfg = invoiceStorageConfigFromEnv(process.env);
for (const [name, value] of Object.entries(mediaCfg)) {
	if (!value) throw new Error(`Storage env var for "${name}" is not set — see .env.example`);
}
if (fiscalCfg.bucket === mediaCfg.bucket) {
	throw new Error('S3_INVOICE_BUCKET must not be the media bucket — nothing to move into itself');
}

const media = createStorage(mediaCfg);
const fiscal = createStorage(fiscalCfg);
console.log(`Fiscal bucket "${fiscalCfg.bucket}": ${await fiscal.ensureBucket()}`);
const outcome = await migrateFiscalObjects({ from: media, to: fiscal });
console.log(
	`Moved ${outcome.moved} object(s) from "${mediaCfg.bucket}/invoices/" to "${fiscalCfg.bucket}"` +
		(outcome.alreadyThere ? ` (${outcome.alreadyThere} already there, public copy removed)` : '')
);
