// Content export/import CLI — the cross-site content sharing mechanism.
// Usage:
//   pnpm content export --type article|quiz|product --slug <slug> [--out file.json]
//   pnpm content import <file.json>
// Export prints the bundle to stdout unless --out is given. Import targets the
// database + bucket of the CURRENT env (DATABASE_URL, S3_*) — to move content
// between sites, run export against site A's env and import against site B's:
//   DATABASE_URL=…life S3_BUCKET=…life pnpm content import article.json
import { config } from 'dotenv';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createDb } from '../src/lib/db/client.ts';
import { isContentType, parseBundle } from '../src/lib/modules/content/bundle.ts';
import { exportContent } from '../src/lib/modules/content/export.ts';
import { importContent } from '../src/lib/modules/content/import.ts';
import { storageConfigFromEnv } from '../src/lib/modules/media/env.ts';
import { createStorage } from '../src/lib/modules/media/storage.ts';

config({ path: path.resolve(import.meta.dirname, '../../../.env') });

const USAGE = `Usage:
  pnpm content export --type article|quiz|product --slug <slug> [--out file.json]
  pnpm content import <file.json>`;

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

const argv = process.argv.slice(2);
if (argv[0] === '--') argv.shift();
const command = argv.shift();
if (command !== 'export' && command !== 'import') fail(USAGE);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) fail('DATABASE_URL is not set');
const storageCfg = storageConfigFromEnv(process.env);
if (!storageCfg.endpoint || !storageCfg.bucket) fail('S3_ENDPOINT / S3_BUCKET are not set');

const db = createDb(databaseUrl);
const deps = { db, storage: createStorage(storageCfg) };

try {
	if (command === 'export') {
		const { values } = parseArgs({
			args: argv,
			options: { type: { type: 'string' }, slug: { type: 'string' }, out: { type: 'string' } }
		});
		const { type, slug, out } = values;
		if (!type || !slug) fail(USAGE);
		if (!isContentType(type)) fail(`Unknown --type "${type}" — expected article, quiz or product`);
		const result = await exportContent(deps, { type, slug });
		if (!result.ok)
			fail(`Export failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`);
		const json = JSON.stringify(result.value, null, '\t');
		if (out) {
			await writeFile(out, json + '\n', 'utf8');
			console.error(
				`Exported ${type} "${slug}" (${result.value.media.length} media object(s)) to ${out}`
			);
		} else {
			console.log(json);
		}
	} else {
		const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
		const file = positionals[0];
		if (!file) fail(USAGE);
		let raw: unknown;
		try {
			raw = JSON.parse(await readFile(file, 'utf8'));
		} catch (err) {
			fail(`Cannot read bundle ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
		const parsed = parseBundle(raw);
		if (!parsed.ok) fail(`Invalid bundle: ${parsed.error}`);
		const result = await importContent(deps, parsed.bundle);
		if (!result.ok)
			fail(`Import failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`);
		const s = result.value;
		console.log(
			`${s.action === 'created' ? 'Created' : 'Updated'} ${s.type} "${s.slug}" — media: ${s.mediaCreated} uploaded, ${s.mediaReused} already present; pillars tagged: ${s.pillarsTagged.join(', ') || '(none)'}`
		);
		if (s.pillarsSkipped.length) {
			console.error(
				`Warning: pillar(s) not present in the target database were skipped: ${s.pillarsSkipped.join(', ')}`
			);
		}
	}
} finally {
	await db.$client.end();
}
