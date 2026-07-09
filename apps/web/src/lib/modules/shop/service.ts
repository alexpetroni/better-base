import { and, desc, eq, exists, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { pillars } from '../../db/schema/core.ts';
import type { Result } from '../../util/result.ts';
import { nextUniqueSlug, slugify } from '../../util/slug.ts';
import { media, type MediaRow } from '../media/schema.ts';
import { productPillars, products, type ProductRow, type ProductStatus } from './schema.ts';

/**
 * Product service. Framework-free ({ db } passed in) like blog/quiz. The
 * public visibility rule matches articles and quizzes: `active` AND tagged to
 * at least one pillar from the active site's config.
 */

export interface ShopDeps {
	db: Db;
}

export type ShopError =
	| 'not-found'
	| 'invalid-name'
	| 'invalid-slug'
	| 'invalid-price'
	| 'invalid-stock'
	| 'unknown-pillar';

export type ShopResult<T> = Result<T, ShopError>;

export interface ProductWithPillars {
	product: ProductRow;
	pillarSlugs: string[];
	cover: MediaRow | null;
	galleryMedia: MediaRow[];
}

/** Tracked stock that ran out. Untracked (null) stock never blocks a purchase. */
export function isOutOfStock(product: Pick<ProductRow, 'stock'>): boolean {
	return product.stock !== null && product.stock <= 0;
}

/** May this product be bought on a site with the given active pillars? */
export function isPurchasable(
	product: Pick<ProductRow, 'status' | 'stock'>,
	productPillarSlugs: string[],
	sitePillarSlugs: string[]
): boolean {
	return (
		product.status === 'active' &&
		!isOutOfStock(product) &&
		productPillarSlugs.some((slug) => sitePillarSlugs.includes(slug))
	);
}

async function slugTaken(db: Db, slug: string, excludeId?: string): Promise<boolean> {
	const rows = await db.select({ id: products.id }).from(products).where(eq(products.slug, slug));
	return rows.some((r) => r.id !== excludeId);
}

export async function ensureUniqueProductSlug(
	deps: ShopDeps,
	base: string,
	excludeId?: string
): Promise<string> {
	const root = slugify(base) || 'produs';
	const taken = await deps.db
		.select({ slug: products.slug, id: products.id })
		.from(products)
		.where(or(eq(products.slug, root), ilike(products.slug, `${root}-%`)));
	const takenSet = new Set(taken.filter((r) => r.id !== excludeId).map((r) => r.slug));
	return nextUniqueSlug(root, (slug) => takenSet.has(slug));
}

export async function createProduct(
	deps: ShopDeps,
	input: { name: string }
): Promise<ShopResult<ProductRow>> {
	const name = input.name.trim();
	if (!name) return { ok: false, error: 'invalid-name' };
	const slug = await ensureUniqueProductSlug(deps, name);
	const [row] = await deps.db
		.insert(products)
		.values({ id: crypto.randomUUID(), slug, name })
		.returning();
	return { ok: true, value: row };
}

export interface ProductPatch {
	name?: string;
	slug?: string;
	descriptionMd?: string;
	/** Integer bani; never a float. */
	priceCents?: number;
	status?: ProductStatus;
	coverMediaId?: string | null;
	gallery?: string[];
	/** null = untracked stock. */
	stock?: number | null;
	pillarSlugs?: string[];
}

export async function updateProduct(
	deps: ShopDeps,
	id: string,
	patch: ProductPatch
): Promise<ShopResult<ProductRow>> {
	const existing = await deps.db.select().from(products).where(eq(products.id, id));
	if (existing.length === 0) return { ok: false, error: 'not-found' };

	const set: Partial<typeof products.$inferInsert> = { updatedAt: new Date() };
	if (patch.name !== undefined) {
		const name = patch.name.trim();
		if (!name) return { ok: false, error: 'invalid-name' };
		set.name = name;
	}
	if (patch.slug !== undefined) {
		const normalized = slugify(patch.slug);
		if (!normalized) return { ok: false, error: 'invalid-slug' };
		set.slug = (await slugTaken(deps.db, normalized, id))
			? await ensureUniqueProductSlug(deps, normalized, id)
			: normalized;
	}
	if (patch.priceCents !== undefined) {
		if (!Number.isInteger(patch.priceCents) || patch.priceCents < 0) {
			return { ok: false, error: 'invalid-price' };
		}
		set.priceCents = patch.priceCents;
	}
	if (patch.stock !== undefined) {
		if (patch.stock !== null && (!Number.isInteger(patch.stock) || patch.stock < 0)) {
			return { ok: false, error: 'invalid-stock' };
		}
		set.stock = patch.stock;
	}
	if (patch.descriptionMd !== undefined) set.descriptionMd = patch.descriptionMd;
	if (patch.status !== undefined) set.status = patch.status;
	if (patch.coverMediaId !== undefined) set.coverMediaId = patch.coverMediaId;
	if (patch.gallery !== undefined) set.gallery = patch.gallery;

	let pillarRows: Array<typeof pillars.$inferSelect> | null = null;
	if (patch.pillarSlugs !== undefined) {
		const unique = [...new Set(patch.pillarSlugs)];
		const rows = unique.length
			? await deps.db.select().from(pillars).where(inArray(pillars.slug, unique))
			: [];
		if (rows.length !== unique.length) {
			const known = new Set(rows.map((r) => r.slug));
			return {
				ok: false,
				error: 'unknown-pillar',
				detail: unique.filter((s) => !known.has(s)).join(', ')
			};
		}
		pillarRows = rows;
	}

	// Retag + row update commit together: a failure between the join-table
	// delete and re-insert must not strip the product's tags — that would
	// silently hide it from every site.
	const row = await deps.db.transaction(async (tx) => {
		if (pillarRows !== null) {
			await tx.delete(productPillars).where(eq(productPillars.productId, id));
			if (pillarRows.length) {
				await tx
					.insert(productPillars)
					.values(pillarRows.map((p) => ({ productId: id, pillarId: p.id })));
			}
		}
		const [updated] = await tx.update(products).set(set).where(eq(products.id, id)).returning();
		return updated;
	});
	return { ok: true, value: row };
}

async function pillarSlugsFor(db: Db, productId: string): Promise<string[]> {
	const rows = await db
		.select({ slug: pillars.slug })
		.from(productPillars)
		.innerJoin(pillars, eq(productPillars.pillarId, pillars.id))
		.where(eq(productPillars.productId, productId))
		.orderBy(pillars.sort);
	return rows.map((r) => r.slug);
}

async function mediaFor(
	db: Db,
	product: ProductRow
): Promise<Pick<ProductWithPillars, 'cover' | 'galleryMedia'>> {
	const ids = [
		...new Set([product.coverMediaId, ...product.gallery].filter((v): v is string => !!v))
	];
	const rows = ids.length ? await db.select().from(media).where(inArray(media.id, ids)) : [];
	const byId = new Map(rows.map((r) => [r.id, r]));
	return {
		cover: product.coverMediaId ? (byId.get(product.coverMediaId) ?? null) : null,
		galleryMedia: product.gallery.flatMap((id) => byId.get(id) ?? [])
	};
}

export async function getProduct(deps: ShopDeps, id: string): Promise<ProductWithPillars | null> {
	const [product] = await deps.db.select().from(products).where(eq(products.id, id));
	if (!product) return null;
	return {
		product,
		pillarSlugs: await pillarSlugsFor(deps.db, id),
		...(await mediaFor(deps.db, product))
	};
}

/**
 * Fetch by slug for the public product page: only `active` products tagged
 * to one of the given site pillars (unless `includeHidden`, for admin).
 */
export async function getProductBySlug(
	deps: ShopDeps,
	slug: string,
	opts: { sitePillarSlugs: string[]; includeHidden?: boolean }
): Promise<ProductWithPillars | null> {
	const [product] = await deps.db.select().from(products).where(eq(products.slug, slug));
	if (!product) return null;
	const pillarSlugs = await pillarSlugsFor(deps.db, product.id);
	if (!opts.includeHidden) {
		if (product.status !== 'active') return null;
		if (!pillarSlugs.some((s) => opts.sitePillarSlugs.includes(s))) return null;
	}
	return { product, pillarSlugs, ...(await mediaFor(deps.db, product)) };
}

export interface CatalogItem {
	product: ProductRow;
	cover: MediaRow | null;
}

/**
 * The public catalog: `active` products tagged to at least one of the given
 * pillar slugs (the active site's pillars). `pillarFilter` narrows to a
 * single pillar and must itself be one of `pillarSlugs`.
 */
export async function listVisibleProducts(
	deps: ShopDeps,
	opts: { pillarSlugs: string[]; pillarFilter?: string }
): Promise<CatalogItem[]> {
	const slugs = opts.pillarFilter
		? opts.pillarSlugs.filter((s) => s === opts.pillarFilter)
		: opts.pillarSlugs;
	if (slugs.length === 0) return [];

	const taggedToActivePillar = exists(
		deps.db
			.select({ one: sql`1` })
			.from(productPillars)
			.innerJoin(pillars, eq(productPillars.pillarId, pillars.id))
			.where(and(eq(productPillars.productId, products.id), inArray(pillars.slug, slugs)))
	);

	const rows = await deps.db
		.select({ product: products, cover: media })
		.from(products)
		.leftJoin(media, eq(products.coverMediaId, media.id))
		.where(and(eq(products.status, 'active'), taggedToActivePillar))
		.orderBy(desc(products.createdAt), desc(products.id));
	return rows;
}

/** Admin listing: optional status filter and case-insensitive name/slug search. */
export async function listProducts(
	deps: ShopDeps,
	opts: { status?: ProductStatus; search?: string } = {}
): Promise<ProductRow[]> {
	const conditions = [];
	if (opts.status) conditions.push(eq(products.status, opts.status));
	if (opts.search?.trim()) {
		const term = `%${opts.search.trim()}%`;
		conditions.push(or(ilike(products.name, term), ilike(products.slug, term)));
	}
	return deps.db
		.select()
		.from(products)
		.where(conditions.length ? and(...conditions) : undefined)
		.orderBy(desc(products.updatedAt), desc(products.id));
}
