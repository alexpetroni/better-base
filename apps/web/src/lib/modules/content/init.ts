// Bulk import of content bundles from a directory on disk — the "initial
// content" mechanism. A site ships its starting articles/quizzes/products as
// `*.json` bundles (the exact format `pnpm content export` produces) under
// `content/common/` + `content/<site-id>/`, and `pnpm db:seed` imports them.
//
// NOT re-exported from `./index.ts` on purpose: this file touches `node:fs`,
// so it must never be pulled into the SvelteKit client/server bundle. Import
// it directly from scripts and tests.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseBundle, type ContentType } from './bundle.ts';
import type { ContentDeps } from './export.ts';
import { importContent, type ImportOptions, type ImportSummary } from './import.ts';

/** One bundle file's outcome. `ok: false` never aborts the run — see importContentDir. */
export type InitFileResult =
	| { file: string; ok: true; type: ContentType; summary: ImportSummary }
	| { file: string; ok: false; error: string };

export interface InitDirSummary {
	/** Directories that were read (missing ones are skipped, not an error). */
	dirs: string[];
	results: InitFileResult[];
	imported: number;
	failed: number;
}

/**
 * The bundle directories for a site, in import order: shared content first,
 * then site-specific (so a site-local file can update a common item).
 * `baseDir` is the repo's `content/` directory.
 */
export function contentDirsFor(baseDir: string, siteId: string): string[] {
	return [path.join(baseDir, 'common'), path.join(baseDir, siteId)];
}

/** `*.json` files in `dir`, sorted by name — a `010-` prefix therefore controls order. */
async function bundleFiles(dir: string): Promise<string[] | null> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (err) {
		// A missing directory is normal (a site may ship no initial content);
		// anything else (permissions, not-a-directory) is a real failure.
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw err;
	}
	return entries
		.filter((e) => e.isFile() && e.name.endsWith('.json'))
		.map((e) => path.join(dir, e.name))
		.sort();
}

/**
 * Import every bundle in `dirs`, in order, one file at a time.
 *
 * Idempotent: each file goes through `importContent`, which upserts by slug
 * and matches media by storage key — re-running imports nothing twice.
 *
 * A bad file (unreadable, invalid JSON, malformed bundle, refused import) is
 * recorded in `results` and the run CONTINUES, so one broken bundle cannot
 * block the rest of a site's initial content. Callers should treat a non-zero
 * `failed` count as an error (the seed script exits non-zero).
 */
export async function importContentDirs(
	deps: ContentDeps,
	dirs: string[],
	options: ImportOptions = {}
): Promise<InitDirSummary> {
	const summary: InitDirSummary = { dirs: [], results: [], imported: 0, failed: 0 };

	for (const dir of dirs) {
		const files = await bundleFiles(dir);
		if (files === null) continue;
		summary.dirs.push(dir);

		for (const file of files) {
			const result = await importFile(deps, file, options);
			summary.results.push(result);
			if (result.ok) summary.imported++;
			else summary.failed++;
		}
	}
	return summary;
}

async function importFile(
	deps: ContentDeps,
	file: string,
	options: ImportOptions
): Promise<InitFileResult> {
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(file, 'utf8'));
	} catch (err) {
		return { file, ok: false, error: err instanceof Error ? err.message : String(err) };
	}
	const parsed = parseBundle(raw);
	if (!parsed.ok) return { file, ok: false, error: parsed.error };

	const imported = await importContent(deps, parsed.bundle, options);
	if (!imported.ok) {
		return {
			file,
			ok: false,
			error: imported.detail ? `${imported.error}: ${imported.detail}` : imported.error
		};
	}
	return { file, ok: true, type: parsed.bundle.type, summary: imported.value };
}

/** One human-readable line per file, for CLI output. */
export function formatInitResult(result: InitFileResult): string {
	const name = path.basename(result.file);
	if (!result.ok) return `  ✗ ${name} — ${result.error}`;
	const s = result.summary;
	const untagged = s.pillarsTagged.length ? '' : ' [UNTAGGED — invisible in listings]';
	return `  ✓ ${name} — ${s.action} ${s.type} "${s.slug}" (media: ${s.mediaCreated} new, ${s.mediaReused} reused)${untagged}`;
}
