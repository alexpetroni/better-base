import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import { imageSize } from 'image-size';
import type { Db } from '../../db/client.ts';
import type { Result as ResultOf } from '../../util/result.ts';
import { blurhashFromPng, BLURHASH_SOURCE_PX } from './blurhash.ts';
import type { ImageProvider } from './image.ts';
import { media, type MediaRow, type VideoProvider } from './schema.ts';
import type { Storage } from './storage.ts';
import { looksLikeSvg, sanitizeSvg } from './svg.ts';
import { isAllowedImageMime, mediaKeyFor, validateUpload } from './validation.ts';

/**
 * Media service. Framework-free: deps (db + storage) are passed in so the
 * same functions serve routes, scripts and integration tests.
 */

export interface MediaDeps {
	db: Db;
	storage: Storage;
	/**
	 * When present AND able to transform, `confirmUpload` also computes a
	 * blurhash from a tiny render. Optional so storage-only callers keep
	 * working; a row confirmed without it stays `blurhash: null` until
	 * `pnpm media:blurhash` runs against a transforming provider.
	 */
	images?: ImageProvider;
}

export type MediaError = 'invalid-mime' | 'invalid-size' | 'not-found' | 'referenced';

export type Result<T> = ResultOf<T, MediaError>;

/**
 * Reference checks other modules provide (blog covers, product images, …).
 * `deleteMedia` refuses to delete a row any check reports as referenced.
 */
export type MediaReferenceCheck = {
	name: string;
	isReferenced: (db: Db, mediaId: string) => Promise<boolean>;
};

/**
 * Deletion needs the full check list injected explicitly (the app wires it
 * in `$lib/server/media-library.ts` `MEDIA_REFERENCE_CHECKS`) — a required
 * field, so protection can't silently vanish with an import-order change.
 */
export interface MediaDeleteDeps extends MediaDeps {
	referenceChecks: MediaReferenceCheck[];
}

export interface UploadTicket {
	key: string;
	uploadUrl: string;
}

/** Step 1 of an upload: validate the declared file and presign a direct PUT. */
export async function requestUpload(
	deps: MediaDeps,
	input: { filename: string; mime: string; size: number }
): Promise<Result<UploadTicket>> {
	const validation = validateUpload(input);
	if (!validation.ok) {
		return { ok: false, error: validation.reason === 'mime' ? 'invalid-mime' : 'invalid-size' };
	}
	const key = mediaKeyFor(input.filename, validation.mime, {
		now: new Date(),
		id: crypto.randomUUID()
	});
	const uploadUrl = await deps.storage.presignPut(key, validation.mime, input.size);
	return { ok: true, value: { key, uploadUrl } };
}

/**
 * Step 2, after the browser PUT succeeded: verify the object really landed
 * (size/mime enforced by the presigned signature, re-checked here), read its
 * dimensions server-side and record the row.
 *
 * Deliberately not transactional (audit Theme B): storage is external, so the
 * only DB write is the single row insert. A failure here strands an orphan
 * object in the bucket — harmless, invisible, and re-confirmable — never a
 * corrupt row.
 */
export async function confirmUpload(
	deps: MediaDeps,
	input: { key: string; filename: string; alt?: string; createdBy: string }
): Promise<Result<MediaRow>> {
	const stat = await deps.storage.statObject(input.key);
	if (!stat) return { ok: false, error: 'not-found', detail: 'object not in storage' };
	if (!stat.mime || !isAllowedImageMime(stat.mime)) return { ok: false, error: 'invalid-mime' };
	const validation = validateUpload({ mime: stat.mime, size: stat.size });
	if (!validation.ok) {
		return { ok: false, error: validation.reason === 'mime' ? 'invalid-mime' : 'invalid-size' };
	}

	let dimensions: { width: number | null; height: number | null } = { width: null, height: null };
	try {
		const bytes = await deps.storage.getObjectBytes(input.key);
		const size = imageSize(bytes);
		if (size.width && size.height) {
			dimensions = { width: Math.round(size.width), height: Math.round(size.height) };
		}
	} catch {
		// Undetectable dimensions (e.g. an SVG without width/viewBox) are not fatal.
	}

	// SVGs are active content and no provider rasterizes them, so they are
	// neutralized here — ONCE, at rest — rather than on every serve (audit M1).
	// imgproxy used to do both halves on the way out; Cloudflare and direct
	// hand the stored object to the browser untouched, so the stored object is
	// what has to be safe:
	//   1. scripts/handlers/remote refs stripped, and the clean bytes written
	//      back over the original — the dangerous version stops existing;
	//   2. `Content-Disposition: attachment`, so even a sanitizer miss
	//      downloads instead of executing on the media origin.
	if (stat.mime === 'image/svg+xml') {
		try {
			const source = new TextDecoder().decode(await deps.storage.getObjectBytes(input.key));
			const clean = looksLikeSvg(source) ? sanitizeSvg(source) : '';
			if (clean) await deps.storage.putObject(input.key, clean, stat.mime);
			await deps.storage.setContentDisposition(input.key, 'attachment');
		} catch {
			// Non-fatal for the row, but the object may still be dangerous — the
			// attachment header is the layer that holds either way, and a failed
			// re-upload leaves the original in place rather than a corrupt one.
		}
	}

	let blurhash: string | null = null;
	if (deps.images?.transforms && stat.mime !== 'image/svg+xml') {
		try {
			blurhash = await computeBlurhash(deps.images, input.key);
		} catch {
			// Non-fatal: a corrupt or undecodable upload still confirms (the row
			// just has no placeholder) and `pnpm media:blurhash` can retry later.
		}
	}

	const [row] = await deps.db
		.insert(media)
		.values({
			id: crypto.randomUUID(),
			kind: 'image',
			key: input.key,
			filename: input.filename,
			mime: stat.mime,
			size: stat.size,
			width: dimensions.width,
			height: dimensions.height,
			blurhash,
			alt: input.alt ?? '',
			createdBy: input.createdBy
		})
		.returning();
	return { ok: true, value: row };
}

/**
 * Blurhash for a stored image: the image provider renders the original at
 * ≤32px PNG (the same resize pipeline every page view uses, so every stored
 * format is covered), and the tiny result is encoded pure-JS. Cheap enough for
 * a serverless confirm: one ~1 KB fetch plus a ≤32×32 encode. Throws on any
 * failure — callers decide whether that is fatal.
 *
 * Refuses a non-transforming provider outright: `direct` would hand back the
 * full-size original, and `blurhashFromPng` would either reject the megapixel
 * buffer or, worse, spend real CPU on it.
 */
export async function computeBlurhash(
	images: ImageProvider,
	key: string,
	opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<string> {
	if (!images.transforms) {
		throw new Error(
			`image provider "${images.name}" cannot render the tiny source a blurhash needs`
		);
	}
	const fetchImpl = opts.fetchImpl ?? fetch;
	const url = images.url(key, {
		w: BLURHASH_SOURCE_PX,
		h: BLURHASH_SOURCE_PX,
		fit: 'fit',
		format: 'png'
	});
	const res = await fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
	if (!res.ok) throw new Error(`${images.name} answered ${res.status} for ${key}`);
	return blurhashFromPng(new Uint8Array(await res.arrayBuffer()));
}

/**
 * Fill `blurhash` for legacy image rows (`pnpm media:blurhash`). Idempotent
 * and resumable: only rows still at null are selected, each row is written
 * as soon as it is computed, and a failing row is reported and skipped —
 * re-running retries exactly the rows that are still missing. SVGs are
 * excluded (they are served unrasterized, so no placeholder applies).
 */
export async function backfillBlurhashes(
	deps: { db: Db; images: ImageProvider },
	opts: { log?: (line: string) => void; fetchImpl?: typeof fetch } = {}
): Promise<{ filled: number; failed: number }> {
	const log = opts.log ?? (() => {});
	const rows = await deps.db
		.select({ id: media.id, key: media.key })
		.from(media)
		.where(and(eq(media.kind, 'image'), isNull(media.blurhash), ne(media.mime, 'image/svg+xml')))
		.orderBy(asc(media.createdAt), asc(media.id));

	let filled = 0;
	let failed = 0;
	for (const row of rows) {
		if (!row.key) continue; // unreachable for kind=image (schema check), belt-and-braces
		try {
			const blurhash = await computeBlurhash(deps.images, row.key, {
				fetchImpl: opts.fetchImpl
			});
			await deps.db.update(media).set({ blurhash }).where(eq(media.id, row.id));
			filled++;
		} catch (err) {
			failed++;
			log(`✗ ${row.key}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { filled, failed };
}

/** Record a video embed (provider + external id only — no file handling). */
export async function createVideoEmbed(
	deps: MediaDeps,
	input: { provider: VideoProvider; externalId: string; alt?: string; createdBy: string }
): Promise<MediaRow> {
	const [row] = await deps.db
		.insert(media)
		.values({
			id: crypto.randomUUID(),
			kind: 'video-embed',
			videoProvider: input.provider,
			videoExternalId: input.externalId,
			alt: input.alt ?? '',
			createdBy: input.createdBy
		})
		.returning();
	return row;
}

export function listMedia(deps: Pick<MediaDeps, 'db'>): Promise<MediaRow[]> {
	return deps.db.select().from(media).orderBy(desc(media.createdAt), desc(media.id));
}

export async function getMedia(deps: Pick<MediaDeps, 'db'>, id: string): Promise<MediaRow | null> {
	const [row] = await deps.db.select().from(media).where(eq(media.id, id));
	return row ?? null;
}

export async function updateMediaAlt(
	deps: Pick<MediaDeps, 'db'>,
	id: string,
	alt: string
): Promise<Result<MediaRow>> {
	const [row] = await deps.db.update(media).set({ alt }).where(eq(media.id, id)).returning();
	return row ? { ok: true, value: row } : { ok: false, error: 'not-found' };
}

/**
 * Delete a media row and its storage object. Refuses when any injected
 * reference check reports the row in use.
 *
 * Deliberately not transactional (audit Theme B): the storage delete cannot
 * join a DB transaction. Object-then-row order means a failure between the
 * two leaves a row whose thumbnail 404s; retrying the delete heals it (S3
 * deletes are idempotent). The reverse order would leak unreachable objects
 * with no admin-visible trace to retry.
 */
export async function deleteMedia(deps: MediaDeleteDeps, id: string): Promise<Result<MediaRow>> {
	const row = await getMedia(deps, id);
	if (!row) return { ok: false, error: 'not-found' };

	for (const check of deps.referenceChecks) {
		if (await check.isReferenced(deps.db, id)) {
			return { ok: false, error: 'referenced', detail: check.name };
		}
	}

	if (row.key) await deps.storage.deleteObject(row.key);
	await deps.db.delete(media).where(eq(media.id, id));
	return { ok: true, value: row };
}
