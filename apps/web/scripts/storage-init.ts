// Idempotent storage bootstrap: creates the media bucket if missing.
// Run via `pnpm storage:init` (after `docker compose up -d`).
import { config } from 'dotenv';
import path from 'node:path';
import { createStorage } from '../src/lib/modules/media/storage.ts';
import { storageConfigFromEnv } from '../src/lib/modules/media/env.ts';

config({ path: path.resolve(import.meta.dirname, '../../../.env') });

const cfg = storageConfigFromEnv(process.env);
for (const [name, value] of Object.entries(cfg)) {
	if (!value) throw new Error(`Storage env var for "${name}" is not set — see .env.example`);
}

const storage = createStorage(cfg);
const outcome = await storage.ensureBucket();
console.log(`Bucket "${cfg.bucket}": ${outcome}`);
