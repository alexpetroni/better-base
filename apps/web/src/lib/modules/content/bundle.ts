import type { FormConfig } from 'formcomp';
import type { ScoringConfig } from '../quiz/scoring.ts';

/**
 * Content bundle format: the JSON produced by `pnpm content export` and
 * consumed by `pnpm content import`. This is the cross-site content sharing
 * mechanism — a bundle is self-contained (it carries the original bytes of
 * every referenced media object) so importing never needs access to the
 * source site's database or bucket.
 *
 * Everything here is pure and node-safe: no $env/$app imports, dates travel
 * as ISO strings, file bytes as base64.
 */

export const CONTENT_BUNDLE_VERSION = 1;

export const CONTENT_TYPES = ['article', 'quiz', 'product'] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export function isContentType(value: string): value is ContentType {
	return (CONTENT_TYPES as readonly string[]).includes(value);
}

/** A media row + (for images) the original file bytes, base64-encoded. */
export interface MediaDescriptor {
	id: string;
	kind: 'image' | 'video-embed';
	key: string | null;
	filename: string | null;
	mime: string | null;
	size: number | null;
	width: number | null;
	height: number | null;
	alt: string;
	videoProvider: 'youtube' | 'bunny' | null;
	videoExternalId: string | null;
	dataBase64: string | null;
}

export interface ArticleContent {
	slug: string;
	title: string;
	excerpt: string;
	bodyMd: string;
	coverMediaId: string | null;
	status: 'draft' | 'published';
	publishedAt: string | null;
	seoTitle: string | null;
	seoDescription: string | null;
}

export interface QuizContent {
	slug: string;
	title: string;
	introMd: string;
	formSchema: FormConfig;
	scoring: ScoringConfig;
	status: 'draft' | 'published';
	resultTemplateKey: string;
}

export interface ProductContent {
	slug: string;
	name: string;
	descriptionMd: string;
	priceCents: number;
	currency: string;
	status: 'draft' | 'active' | 'archived';
	coverMediaId: string | null;
	gallery: string[];
	stock: number | null;
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
