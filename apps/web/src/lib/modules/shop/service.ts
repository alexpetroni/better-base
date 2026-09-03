import {
	and,
	desc,
	eq,
	exists,
	inArray,
	isNotNull,
	isNull,
	sql,
	ilike,
	or,
	type SQL
} from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.ts';
import {
	pillarSlugsFor,
	resolvePillarRows,
	setPillars,
	type PillarJoin
} from '../../db/pillar-tags.ts';
import { pillars, type Pillar } from '../../db/schema/core.ts';
import { ensureUniqueSlug, slugTaken } from '../../db/unique-slug.ts';
import type { Result } from '../../util/result.ts';
import { slugify } from '../../util/slug.ts';
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
	/** The stock moved since the form was loaded — detail carries the current value. */
	| 'stock-changed'
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

const PRODUCT_SLUGS = { table: products, id: products.id, slug: products.slug };

const PRODUCT_PILLARS: PillarJoin<typeof productPillars> = {
	table: productPillars,
	parentId: productPillars.productId,
	pillarId: productPillars.pillarId,
	link: (productId, pillarId) => ({ productId, pillarId })
};

/** Derive a free slug from a name (or explicit base), suffixing `-2`, `-3`, … on collision. */
function uniqueProductSlug(db: Db, base: string, excludeId?: string): Promise<string> {
	return ensureUniqueSlug(db, PRODUCT_SLUGS, base, 'produs', excludeId);
}

export async function createProduct(
	deps: ShopDeps,
	input: { name: string }
): Promise<ShopResult<ProductRow>> {
	const name = input.name.trim();
	if (!name) return { ok: false, error: 'invalid-name' };
	const slug = await uniqueProductSlug(deps.db, name);
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
	/**
	 * Optimistic guard for an absolute `stock` write: the value the form was
	 * loaded with. The whole save is refused (`stock-changed`, detail = the
	 * current stock) when the row no longer holds it — a webhook decrement in
	 * between must never be overwritten with a stale number (audit P2).
	 */
	expectedStock?: number | null;
	/**
	 * Relative restock: `stock = stock + delta` in SQL, so it composes with a
	 * concurrent sale instead of racing it. Tracked stock only; wins over
	 * `stock` when both are given.
	 */
	stockDelta?: number;
	pillarSlugs?: string[];
}

/** Thrown inside the save transaction to roll back the retag with the refused write. */
class StockConflict extends Error {
	readonly current: number | null;
	constructor(current: number | null) {
		super('stock changed since the form was loaded');
		this.current = current;
	}
}

export async function updateProduct(
	deps: ShopDeps,
	id: string,
	patch: ProductPatch
): Promise<ShopResult<ProductRow>> {
	const existing = await deps.db.select().from(products).where(eq(products.id, id));
	if (existing.length === 0) return { ok: false, error: 'not-found' };

	const set: PgUpdateSetSource<typeof products> = { updatedAt: new Date() };
	// Extra WHERE for the stock write: the optimistic expectation, or "still
	// tracked" for a relative restock. No match → StockConflict, nothing saved.
	let stockGuard: SQL | undefined;
	if (patch.name !== undefined) {
		const name = patch.name.trim();
		if (!name) return { ok: false, error: 'invalid-name' };
		set.name = name;
	}
	if (patch.slug !== undefined) {
		const normalized = slugify(patch.slug);
		if (!normalized) return { ok: false, error: 'invalid-slug' };
		set.slug = (await slugTaken(deps.db, PRODUCT_SLUGS, normalized, id))
			? await uniqueProductSlug(deps.db, normalized, id)
			: normalized;
	}
	if (patch.priceCents !== undefined) {
		if (!Number.isInteger(patch.priceCents) || patch.priceCents < 0) {
			return { ok: false, error: 'invalid-price' };
		}
		set.priceCents = patch.priceCents;
	}
	if (patch.stockDelta !== undefined) {
		if (!Number.isInteger(patch.stockDelta) || patch.stockDelta <= 0) {
			return { ok: false, error: 'invalid-stock', detail: 'delta' };
		}
		if (existing[0].stock === null)
			return { ok: false, error: 'invalid-stock', detail: 'untracked' };
		set.stock = sql`${products.stock} + ${patch.stockDelta}`;
		stockGuard = isNotNull(products.stock);
	} else if (patch.stock !== undefined) {
		if (patch.stock !== null && (!Number.isInteger(patch.stock) || patch.stock < 0)) {
			return { ok: false, error: 'invalid-stock' };
		}
		set.stock = patch.stock;
		if (patch.expectedStock !== undefined) {
			stockGuard =
				patch.expectedStock === null
					? isNull(products.stock)
					: eq(products.stock, patch.expectedStock);
		}
	}
	if (patch.descriptionMd !== undefined) set.descriptionMd = patch.descriptionMd;
	if (patch.status !== undefined) set.status = patch.status;
	if (patch.coverMediaId !== undefined) set.coverMediaId = patch.coverMediaId;
	if (patch.gallery !== undefined) set.gallery = patch.gallery;

	let pillarRows: Pillar[] | null = null;
	if (patch.pillarSlugs !== undefined) {
		const resolved = await resolvePillarRows(deps.db, patch.pillarSlugs);
		if (!resolved.ok) {
			return { ok: false, error: 'unknown-pillar', detail: resolved.missing.join(', ') };
		}
		pillarRows = resolved.rows;
	}

	// Retag + row update commit together: a failure between the join-table
	// delete and re-insert must not strip the product's tags — that would
	// silently hide it from every site. A refused stock write rolls the retag
	// back with it: the save is all-or-nothing from the operator's view.
	try {
		const row = await deps.db.transaction(async (tx) => {
			if (pillarRows !== null) await setPillars(tx, PRODUCT_PILLARS, id, pillarRows);
			const [updated] = await tx
				.update(products)
				.set(set)
				.where(stockGuard ? and(eq(products.id, id), stockGuard) : eq(products.id, id))
				.returning();
			if (!updated) {
				const [current] = await tx
					.select({ stock: products.stock })
					.from(products)
					.where(eq(products.id, id));
				throw new StockConflict(current?.stock ?? null);
			}
			return updated;
		});
		return { ok: true, value: row };
	} catch (err) {
		if (err instanceof StockConflict) {
			return { ok: false, error: 'stock-changed', detail: String(err.current) };
		}
		throw err;
	}
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
		pillarSlugs: await pillarSlugsFor(deps.db, PRODUCT_PILLARS, id),
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
	const pillarSlugs = await pillarSlugsFor(deps.db, PRODUCT_PILLARS, product.id);
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
