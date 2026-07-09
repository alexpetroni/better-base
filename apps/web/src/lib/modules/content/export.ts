import { eq, inArray, or } from 'drizzle-orm';
import { pillars } from '../../db/schema/core.ts';
import type { Db } from '../../db/client.ts';
import { extractMediaRefs } from '../blog/markdown.ts';
import { articlePillars, articles } from '../blog/schema.ts';
import { media, type MediaRow } from '../media/schema.ts';
import type { Storage } from '../media/storage.ts';
import { quizzes } from '../quiz/schema.ts';
import { productPillars, products } from '../shop/schema.ts';
import {
	CONTENT_BUNDLE_VERSION,
	articleToContent,
	mediaToDescriptor,
	productToContent,
	quizToContent,
	type ContentBundle,
	type ContentType,
	type MediaDescriptor
} from './bundle.ts';

export interface ContentDeps {
	db: Db;
	storage: Storage;
}

export type ContentError = 'not-found' | 'missing-object' | 'invalid-bundle' | 'missing-pillars';

export type ContentResult<T> =
	{ ok: true; value: T } | { ok: false; error: ContentError; detail?: string };

/**
 * Resolve `media:` refs (row id OR storage key — same rule as rendering) plus
 * direct id references (cover, gallery) to media rows. Unresolvable refs are
 * skipped, matching the renderer (unresolved refs display as nothing).
 */
async function collectMedia(db: Db, refs: string[]): Promise<MediaRow[]> {
	const unique = [...new Set(refs.filter((r) => r.length > 0))];
	if (!unique.length) return [];
	const rows = await db
		.select()
		.from(media)
		.where(or(inArray(media.id, unique), inArray(media.key, unique)));
	// Dedupe: an id ref and a key ref may hit the same row.
	return [...new Map(rows.map((row) => [row.id, row])).values()];
}

async function toDescriptor(
	storage: Storage,
	row: MediaRow
): Promise<ContentResult<MediaDescriptor>> {
	let dataBase64: string | null = null;
	if (row.kind === 'image') {
		if (!row.key)
			return { ok: false, error: 'invalid-bundle', detail: `image row ${row.id} has no key` };
		const stat = await storage.statObject(row.key);
		if (!stat) return { ok: false, error: 'missing-object', detail: row.key };
		dataBase64 = Buffer.from(await storage.getObjectBytes(row.key)).toString('base64');
	}
	return { ok: true, value: mediaToDescriptor(row, dataBase64) };
}

async function pillarSlugsFor(db: Db, ids: number[]): Promise<string[]> {
	if (!ids.length) return [];
	const rows = await db.select().from(pillars).where(inArray(pillars.id, ids));
	const bySlug = new Map(rows.map((r) => [r.id, r.slug]));
	return ids.map((id) => bySlug.get(id)).filter((s): s is string => !!s);
}

/** Export one content item (any status) as a self-contained bundle. */
export async function exportContent(
	deps: ContentDeps,
	input: { type: ContentType; slug: string }
): Promise<ContentResult<ContentBundle>> {
	const { db, storage } = deps;

	if (input.type === 'article') {
		const [row] = await db.select().from(articles).where(eq(articles.slug, input.slug));
		if (!row) return { ok: false, error: 'not-found', detail: `article "${input.slug}"` };
		const joins = await db
			.select()
			.from(articlePillars)
			.where(eq(articlePillars.articleId, row.id));
		const mediaRows = await collectMedia(db, [
			...(row.coverMediaId ? [row.coverMediaId] : []),
			...extractMediaRefs(row.bodyMd)
		]);
		const descriptors: MediaDescriptor[] = [];
		for (const m of mediaRows) {
			const d = await toDescriptor(storage, m);
			if (!d.ok) return d;
			descriptors.push(d.value);
		}
		return {
			ok: true,
			value: {
				version: CONTENT_BUNDLE_VERSION,
				type: 'article',
				pillars: await pillarSlugsFor(
					db,
					joins.map((j) => j.pillarId)
				),
				media: descriptors,
				article: articleToContent(row)
			}
		};
	}

	if (input.type === 'quiz') {
		const [row] = await db.select().from(quizzes).where(eq(quizzes.slug, input.slug));
		if (!row) return { ok: false, error: 'not-found', detail: `quiz "${input.slug}"` };
		const mediaRows = await collectMedia(db, extractMediaRefs(row.introMd));
		const descriptors: MediaDescriptor[] = [];
		for (const m of mediaRows) {
			const d = await toDescriptor(storage, m);
			if (!d.ok) return d;
			descriptors.push(d.value);
		}
		return {
			ok: true,
			value: {
				version: CONTENT_BUNDLE_VERSION,
				type: 'quiz',
				pillars: row.pillarId === null ? [] : await pillarSlugsFor(db, [row.pillarId]),
				media: descriptors,
				quiz: quizToContent(row)
			}
		};
	}

	const [row] = await db.select().from(products).where(eq(products.slug, input.slug));
	if (!row) return { ok: false, error: 'not-found', detail: `product "${input.slug}"` };
	const joins = await db.select().from(productPillars).where(eq(productPillars.productId, row.id));
	const mediaRows = await collectMedia(db, [
		...(row.coverMediaId ? [row.coverMediaId] : []),
		...row.gallery,
		...extractMediaRefs(row.descriptionMd)
	]);
	const descriptors: MediaDescriptor[] = [];
	for (const m of mediaRows) {
		const d = await toDescriptor(storage, m);
		if (!d.ok) return d;
		descriptors.push(d.value);
	}
	return {
		ok: true,
		value: {
			version: CONTENT_BUNDLE_VERSION,
			type: 'product',
			pillars: await pillarSlugsFor(
				db,
				joins.map((j) => j.pillarId)
			),
			media: descriptors,
			product: productToContent(row)
		}
	};
}
