import type { ArticleRow } from '../blog/schema.ts';
import type { MediaRow } from '../media/schema.ts';
import type { QuizRow } from '../quiz/schema.ts';
import type { ProductRow } from '../shop/schema.ts';

/**
 * Content bundle format: the JSON produced by `pnpm content export` and
 * consumed by `pnpm content import`. This is the cross-site content sharing
 * mechanism — a bundle is self-contained (it carries the original bytes of
 * every referenced media object) so importing never needs access to the
 * source site's database or bucket.
 *
 * Everything here is pure and node-safe: no $env/$app imports, dates travel
 * as ISO strings, file bytes as base64.
 *
 * The `*Content`/`MediaDescriptor` types are DERIVED from the Drizzle row
 * types: every persisted column travels in the bundle unless it is listed in
 * `BUNDLE_EXCLUDED_COLUMNS`. Adding a column to a schema therefore fails to
 * compile in the `*ToContent` mappers below until the bundle carries it (or
 * the column is deliberately excluded); `bundle.spec.ts` additionally asserts
 * the runtime parity between table columns and bundle keys.
 */

// Version 2: media descriptors gained the (previously dropped) `blurhash`
// column. v1 files were lossy — re-export them from the source site.
export const CONTENT_BUNDLE_VERSION = 2;

export const CONTENT_TYPES = ['article', 'quiz', 'product'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export function isContentType(value: string): value is ContentType {
	return (CONTENT_TYPES as readonly string[]).includes(value);
}

/**
 * Columns that deliberately do NOT travel in a bundle. Everything else must.
 * - `id`: target-local (regenerated on collision); media ids DO travel
 *   because markdown `media:` refs point at them.
 * - `pillarId` / join rows: pillars travel as canonical SLUGS — numeric ids
 *   differ per database.
 * - `stripeProductId`/`stripePriceId`: belong to the source site's Stripe
 *   account; the target re-syncs its own.
 * - `createdBy`: users are site-local.
 * - `createdAt`/`updatedAt`: stamped by the target database.
 */
export const BUNDLE_EXCLUDED_COLUMNS = {
	article: ['id', 'createdBy', 'createdAt', 'updatedAt'],
	quiz: ['id', 'pillarId', 'createdBy', 'createdAt', 'updatedAt'],
	product: ['id', 'stripeProductId', 'stripePriceId', 'createdAt', 'updatedAt'],
	media: ['createdBy', 'createdAt']
} as const satisfies Record<string, readonly string[]>;

/** Dates travel as ISO strings; everything else keeps its row type. (Tuple
 * wrapping stops the conditional from distributing over `X | null` unions.) */
type Serialized<T> = [T] extends [Date] ? string : [T] extends [Date | null] ? string | null : T;

type BundleFields<Row, Excluded extends keyof Row> = {
	[K in Exclude<keyof Row, Excluded>]: Serialized<Row[K]>;
};

export type ArticleContent = BundleFields<
	ArticleRow,
	(typeof BUNDLE_EXCLUDED_COLUMNS.article)[number]
>;

export type QuizContent = BundleFields<QuizRow, (typeof BUNDLE_EXCLUDED_COLUMNS.quiz)[number]>;

export type ProductContent = BundleFields<
	ProductRow,
	(typeof BUNDLE_EXCLUDED_COLUMNS.product)[number]
>;

/** A media row + (for images) the original file bytes, base64-encoded. */
export type MediaDescriptor = BundleFields<
	MediaRow,
	(typeof BUNDLE_EXCLUDED_COLUMNS.media)[number]
> & {
	dataBase64: string | null;
};

/**
 * Row → bundle mappers. These object literals are the compiler link between
 * schema and bundle: a new column makes them fail to compile until it is
 * mapped here (and, via the spread-based inserts in `import.ts`, it then
 * round-trips automatically).
 */
export function articleToContent(row: ArticleRow): ArticleContent {
	return {
		slug: row.slug,
		title: row.title,
		excerpt: row.excerpt,
		bodyMd: row.bodyMd,
		coverMediaId: row.coverMediaId,
		status: row.status,
		publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
		seoTitle: row.seoTitle,
		seoDescription: row.seoDescription
	};
}

export function quizToContent(row: QuizRow): QuizContent {
	return {
		slug: row.slug,
		title: row.title,
		introMd: row.introMd,
		formSchema: row.formSchema,
		scoring: row.scoring,
		status: row.status,
		resultTemplateKey: row.resultTemplateKey
	};
}

export function productToContent(row: ProductRow): ProductContent {
	return {
		slug: row.slug,
		name: row.name,
		descriptionMd: row.descriptionMd,
		priceCents: row.priceCents,
		currency: row.currency,
		status: row.status,
		coverMediaId: row.coverMediaId,
		gallery: row.gallery,
		stock: row.stock
	};
}

export function mediaToDescriptor(row: MediaRow, dataBase64: string | null): MediaDescriptor {
	return {
		id: row.id,
		kind: row.kind,
		key: row.key,
		filename: row.filename,
		mime: row.mime,
		size: row.size,
		width: row.width,
		height: row.height,
		alt: row.alt,
		blurhash: row.blurhash,
		videoProvider: row.videoProvider,
		videoExternalId: row.videoExternalId,
		dataBase64
	};
}

interface BundleBase {
	version: typeof CONTENT_BUNDLE_VERSION;
	/** Pillar SLUGS (canonical, site-independent) — ids differ per database. */
	pillars: string[];
	media: MediaDescriptor[];
}

export type ContentBundle = BundleBase &
	(
		| { type: 'article'; article: ArticleContent }
		| { type: 'quiz'; quiz: QuizContent }
		| { type: 'product'; product: ProductContent }
	);

/**
 * Rewrite `![alt](media:REF)` references whose REF appears in `map`.
 * Used on import when a media row had to be inserted under a fresh id;
 * key-based refs survive unchanged because storage keys are preserved.
 */
export function remapMediaRefs(md: string, map: ReadonlyMap<string, string>): string {
	return md.replace(
		/(!\[[^\]]*\]\(media:)([^)\s]+)((?:\s[^)]*)?\))/g,
		(all, pre: string, ref: string, post: string) =>
			map.has(ref) ? `${pre}${map.get(ref)}${post}` : all
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

function optionalInt(value: unknown): value is number | null {
	return value === null || Number.isInteger(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function validMediaDescriptor(raw: unknown): raw is MediaDescriptor {
	if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.alt !== 'string') return false;
	if (!optionalString(raw.blurhash)) return false;
	if (raw.kind === 'image') {
		return (
			typeof raw.key === 'string' &&
			typeof raw.filename === 'string' &&
			typeof raw.mime === 'string' &&
			Number.isInteger(raw.size) &&
			typeof raw.dataBase64 === 'string' &&
			optionalInt(raw.width) &&
			optionalInt(raw.height)
		);
	}
	if (raw.kind === 'video-embed') {
		return (
			(raw.videoProvider === 'youtube' || raw.videoProvider === 'bunny') &&
			typeof raw.videoExternalId === 'string' &&
			raw.key === null
		);
	}
	return false;
}

function validArticle(raw: unknown): raw is ArticleContent {
	return (
		isRecord(raw) &&
		typeof raw.slug === 'string' &&
		raw.slug.length > 0 &&
		typeof raw.title === 'string' &&
		typeof raw.excerpt === 'string' &&
		typeof raw.bodyMd === 'string' &&
		optionalString(raw.coverMediaId) &&
		(raw.status === 'draft' || raw.status === 'published') &&
		optionalString(raw.publishedAt) &&
		optionalString(raw.seoTitle) &&
		optionalString(raw.seoDescription)
	);
}

function validQuiz(raw: unknown): raw is QuizContent {
	return (
		isRecord(raw) &&
		typeof raw.slug === 'string' &&
		raw.slug.length > 0 &&
		typeof raw.title === 'string' &&
		typeof raw.introMd === 'string' &&
		isRecord(raw.formSchema) &&
		isRecord(raw.scoring) &&
		(raw.status === 'draft' || raw.status === 'published') &&
		typeof raw.resultTemplateKey === 'string'
	);
}

function validProduct(raw: unknown): raw is ProductContent {
	return (
		isRecord(raw) &&
		typeof raw.slug === 'string' &&
		raw.slug.length > 0 &&
		typeof raw.name === 'string' &&
		typeof raw.descriptionMd === 'string' &&
		Number.isInteger(raw.priceCents) &&
		typeof raw.currency === 'string' &&
		(raw.status === 'draft' || raw.status === 'active' || raw.status === 'archived') &&
		optionalString(raw.coverMediaId) &&
		isStringArray(raw.gallery) &&
		optionalInt(raw.stock)
	);
}

export type ParseBundleResult = { ok: true; bundle: ContentBundle } | { ok: false; error: string };

/** Structural validation of a parsed JSON value. Returns a typed bundle or a human-readable error. */
export function parseBundle(raw: unknown): ParseBundleResult {
	if (!isRecord(raw)) return { ok: false, error: 'Bundle must be a JSON object.' };
	if (raw.version !== CONTENT_BUNDLE_VERSION) {
		return { ok: false, error: `Unsupported bundle version (expected ${CONTENT_BUNDLE_VERSION}).` };
	}
	if (typeof raw.type !== 'string' || !isContentType(raw.type)) {
		return {
			ok: false,
			error: `Unknown content type — expected one of: ${CONTENT_TYPES.join(', ')}.`
		};
	}
	if (!isStringArray(raw.pillars))
		return { ok: false, error: '"pillars" must be a list of slugs.' };
	if (!Array.isArray(raw.media) || !raw.media.every(validMediaDescriptor)) {
		return { ok: false, error: '"media" must be a list of valid media descriptors.' };
	}
	if (raw.type === 'article' && !validArticle(raw.article)) {
		return { ok: false, error: '"article" payload is missing or malformed.' };
	}
	if (raw.type === 'quiz' && !validQuiz(raw.quiz)) {
		return { ok: false, error: '"quiz" payload is missing or malformed.' };
	}
	if (raw.type === 'product' && !validProduct(raw.product)) {
		return { ok: false, error: '"product" payload is missing or malformed.' };
	}
	return { ok: true, bundle: raw as unknown as ContentBundle };
}
