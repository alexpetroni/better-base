import { desc, eq } from 'drizzle-orm';
import { imageSize } from 'image-size';
import type { Db } from '../../db/client.ts';
import type { Result as ResultOf } from '../../util/result.ts';
import { media, type MediaRow, type VideoProvider } from './schema.ts';
import type { Storage } from './storage.ts';
import { isAllowedImageMime, mediaKeyFor, validateUpload } from './validation.ts';

/**
 * Media service. Framework-free: deps (db + storage) are passed in so the
 * same functions serve routes, scripts and integration tests.
 */

export interface MediaDeps {
	db: Db;
	storage: Storage;
}

export type MediaError = 'invalid-mime' | 'invalid-size' | 'not-found' | 'referenced';

export type Result<T> = ResultOf<T, MediaError>;

/**
 * Reference checks other modules register (blog covers, product images, …).
 * `deleteMedia` refuses to delete a row any check reports as referenced.
 */
export type MediaReferenceCheck = {
	name: string;
	isReferenced: (db: Db, mediaId: string) => Promise<boolean>;
};

const referenceChecks: MediaReferenceCheck[] = [];

export function registerMediaReferenceCheck(check: MediaReferenceCheck): () => void {
	referenceChecks.push(check);
	return () => {
		const i = referenceChecks.indexOf(check);
		if (i !== -1) referenceChecks.splice(i, 1);
	};
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
			alt: input.alt ?? '',
			createdBy: input.createdBy
		})
		.returning();
	return { ok: true, value: row };
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
 * Delete a media row and its storage object. Refuses when any registered
 * reference check reports the row in use.
 *
 * Deliberately not transactional (audit Theme B): the storage delete cannot
 * join a DB transaction. Object-then-row order means a failure between the
 * two leaves a row whose thumbnail 404s; retrying the delete heals it (S3
 * deletes are idempotent). The reverse order would leak unreachable objects
 * with no admin-visible trace to retry.
 */
export async function deleteMedia(deps: MediaDeps, id: string): Promise<Result<MediaRow>> {
	const row = await getMedia(deps, id);
	if (!row) return { ok: false, error: 'not-found' };

	for (const check of referenceChecks) {
		if (await check.isReferenced(deps.db, id)) {
			return { ok: false, error: 'referenced', detail: check.name };
		}
	}

	if (row.key) await deps.storage.deleteObject(row.key);
	await deps.db.delete(media).where(eq(media.id, id));
	return { ok: true, value: row };
}
