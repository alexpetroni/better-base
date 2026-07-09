import { and, eq, inArray } from 'drizzle-orm';
import { pillars } from '../../db/schema/core.ts';
import type { Db } from '../../db/client.ts';
import { articlePillars, articles } from '../blog/schema.ts';
import { media } from '../media/schema.ts';
import { quizzes } from '../quiz/schema.ts';
import { productPillars, products } from '../shop/schema.ts';
import { remapMediaRefs, type ContentBundle, type MediaDescriptor } from './bundle.ts';
import type { ContentDeps, ContentResult } from './export.ts';

export interface ImportSummary {
	type: ContentBundle['type'];
	slug: string;
	action: 'created' | 'updated';
	mediaCreated: number;
	mediaReused: number;
	/** Pillar slugs actually tagged in the target database. */
	pillarsTagged: string[];
	/** Bundle pillars with no row in the target database (content stays untagged for them). */
	pillarsSkipped: string[];
}

/** A free media primary key: the source id when unused in the target, else a fresh uuid. */
async function freeMediaId(db: Db, id: string): Promise<string> {
	const [existing] = await db.select({ id: media.id }).from(media).where(eq(media.id, id));
	return existing ? crypto.randomUUID() : id;
}

/**
 * Ensure one media descriptor exists in the target database + bucket.
 * Images are matched by storage key, video embeds by provider + external id —
 * so importing the same bundle twice never duplicates rows or uploads.
 *
 * Matching by key relies on keys being IMMUTABLE: `mediaKeyFor` embeds a
 * uuid fragment per upload, so the bytes behind a given key never change at
 * the source — a key that already exists in the target is guaranteed to hold
 * the same object, and re-import can safely skip the upload. (Replacing an
 * image at the source means uploading a new file → new key → new row here.)
 *
 * Accepted leak: a re-import does NOT delete target media that a previous
 * import created but the updated item no longer references. Such rows stay in
 * the target's media library (harmless, visible, manually deletable there —
 * the library's reference checks keep deletion safe). Sweeping them here
 * would risk deleting media the target site reuses elsewhere.
 */
async function ensureMedia(
	deps: ContentDeps,
	d: MediaDescriptor
): Promise<{ targetId: string; created: boolean }> {
	const { db, storage } = deps;
	// Everything the descriptor carries except the bytes and the (source) id
	// is a media column — new schema columns round-trip without touching this.
	const { dataBase64, id: sourceId, ...columns } = d;
	if (d.kind === 'image') {
		const key = d.key as string; // validated by parseBundle
		const [existing] = await db.select().from(media).where(eq(media.key, key));
		if (existing) return { targetId: existing.id, created: false };
		await storage.putObject(
			key,
			Buffer.from(dataBase64 ?? '', 'base64'),
			d.mime ?? 'application/octet-stream'
		);
		const id = await freeMediaId(db, sourceId);
		await db.insert(media).values({ ...columns, id });
		return { targetId: id, created: true };
	}
	const [existing] = await db
		.select()
		.from(media)
		.where(
			and(
				eq(media.kind, 'video-embed'),
				eq(media.videoProvider, d.videoProvider as 'youtube' | 'bunny'),
				eq(media.videoExternalId, d.videoExternalId as string)
			)
		);
	if (existing) return { targetId: existing.id, created: false };
	const id = await freeMediaId(db, sourceId);
	await db.insert(media).values({ ...columns, id });
	return { targetId: id, created: true };
}

async function resolvePillars(
	db: Db,
	slugs: string[]
): Promise<{ ids: Map<string, number>; tagged: string[]; skipped: string[] }> {
	const unique = [...new Set(slugs)];
	if (!unique.length) return { ids: new Map(), tagged: [], skipped: [] };
	const rows = await db.select().from(pillars).where(inArray(pillars.slug, unique));
	const ids = new Map(rows.map((r) => [r.slug, r.id]));
	return {
		ids,
		tagged: unique.filter((s) => ids.has(s)),
		skipped: unique.filter((s) => !ids.has(s))
	};
}

/**
 * Import a bundle into the target database + bucket (both come from `deps`).
 * Idempotent by slug: an existing item is updated in place, a missing one is
 * created; re-importing the same bundle changes nothing and duplicates nothing.
 */
export async function importContent(
	deps: ContentDeps,
	bundle: ContentBundle
): Promise<ContentResult<ImportSummary>> {
	const { db } = deps;

	const { ids: pillarIds, tagged, skipped } = await resolvePillars(db, bundle.pillars);

	// Media first: build the source-id → target-id map.
	const idMap = new Map<string, string>();
	let mediaCreated = 0;
	let mediaReused = 0;
	for (const d of bundle.media) {
		const { targetId, created } = await ensureMedia(deps, d);
		idMap.set(d.id, targetId);
		if (created) mediaCreated++;
		else mediaReused++;
	}
	// Markdown refs only need rewriting when a row landed under a different id
	// (key-based refs stay valid: storage keys are preserved on import).
	const changed = new Map([...idMap].filter(([from, to]) => from !== to));

	const mapCover = (coverId: string | null): ContentResult<string | null> => {
		if (coverId === null) return { ok: true, value: null };
		const target = idMap.get(coverId);
		if (!target) {
			return {
				ok: false,
				error: 'invalid-bundle',
				detail: `cover media ${coverId} is not in the bundle`
			};
		}
		return { ok: true, value: target };
	};

	const summary = (slug: string, action: 'created' | 'updated'): ImportSummary => ({
		type: bundle.type,
		slug,
		action,
		mediaCreated,
		mediaReused,
		pillarsTagged: tagged,
		pillarsSkipped: skipped
	});

	if (bundle.type === 'article') {
		const a = bundle.article;
		const cover = mapCover(a.coverMediaId);
		if (!cover.ok) return cover;
		// Spread the bundle content and override only the fields that need
		// target-local translation — a new column travels without edits here.
		// (slug stays: updates matched on it, so re-setting it is a no-op.)
		const fields = {
			...a,
			bodyMd: remapMediaRefs(a.bodyMd, changed),
			coverMediaId: cover.value,
			publishedAt: a.publishedAt ? new Date(a.publishedAt) : null
		};
		const [existing] = await db.select().from(articles).where(eq(articles.slug, a.slug));
		let articleId: string;
		let action: 'created' | 'updated';
		if (existing) {
			articleId = existing.id;
			action = 'updated';
			await db
				.update(articles)
				.set({ ...fields, updatedAt: new Date() })
				.where(eq(articles.id, articleId));
		} else {
			articleId = crypto.randomUUID();
			action = 'created';
			await db.insert(articles).values({ id: articleId, ...fields });
		}
		await db.delete(articlePillars).where(eq(articlePillars.articleId, articleId));
		if (tagged.length) {
			await db
				.insert(articlePillars)
				.values(tagged.map((slug) => ({ articleId, pillarId: pillarIds.get(slug) as number })));
		}
		return { ok: true, value: summary(a.slug, action) };
	}

	if (bundle.type === 'quiz') {
		const q = bundle.quiz;
		const fields = {
			...q,
			introMd: remapMediaRefs(q.introMd, changed),
			pillarId: tagged.length ? (pillarIds.get(tagged[0]) as number) : null
		};
		const [existing] = await db.select().from(quizzes).where(eq(quizzes.slug, q.slug));
		if (existing) {
			await db
				.update(quizzes)
				.set({ ...fields, updatedAt: new Date() })
				.where(eq(quizzes.id, existing.id));
			return { ok: true, value: summary(q.slug, 'updated') };
		}
		const id = crypto.randomUUID();
		await db.insert(quizzes).values({ id, ...fields });
		return { ok: true, value: summary(q.slug, 'created') };
	}

	const p = bundle.product;
	const cover = mapCover(p.coverMediaId);
	if (!cover.ok) return cover;
	const gallery: string[] = [];
	for (const mediaId of p.gallery) {
		const target = idMap.get(mediaId);
		if (!target) {
			return {
				ok: false,
				error: 'invalid-bundle',
				detail: `gallery media ${mediaId} is not in the bundle`
			};
		}
		gallery.push(target);
	}
	const fields = {
		...p,
		descriptionMd: remapMediaRefs(p.descriptionMd, changed),
		coverMediaId: cover.value,
		gallery
	};
	const [existing] = await db.select().from(products).where(eq(products.slug, p.slug));
	let productId: string;
	let action: 'created' | 'updated';
	if (existing) {
		// Stripe catalog ids belong to the TARGET site's Stripe account — keep
		// them; the next admin save re-syncs the (possibly new) price. Checkout
		// is unaffected either way: sessions snapshot prices from our rows.
		productId = existing.id;
		action = 'updated';
		await db
			.update(products)
			.set({ ...fields, updatedAt: new Date() })
			.where(eq(products.id, productId));
	} else {
		productId = crypto.randomUUID();
		action = 'created';
		await db.insert(products).values({ id: productId, ...fields });
	}
	await db.delete(productPillars).where(eq(productPillars.productId, productId));
	if (tagged.length) {
		await db
			.insert(productPillars)
			.values(tagged.map((slug) => ({ productId, pillarId: pillarIds.get(slug) as number })));
	}
	return { ok: true, value: summary(p.slug, action) };
}
