import { describe, expect, it } from 'vitest';
import { getTableColumns, type Table } from 'drizzle-orm';
import { articles } from '../blog/schema.ts';
import { media } from '../media/schema.ts';
import { quizzes } from '../quiz/schema.ts';
import { products } from '../shop/schema.ts';
import {
	BUNDLE_EXCLUDED_COLUMNS,
	CONTENT_BUNDLE_VERSION,
	articleToContent,
	mediaToDescriptor,
	parseBundle,
	productToContent,
	quizToContent,
	remapMediaRefs,
	type ContentBundle,
	type MediaDescriptor
} from './bundle.ts';

const IMAGE: MediaDescriptor = {
	id: 'm-1',
	kind: 'image',
	key: 'uploads/2026/07/test-abc.png',
	filename: 'test.png',
	mime: 'image/png',
	size: 3,
	width: 320,
	height: 200,
	alt: 'un test',
	blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
	videoProvider: null,
	videoExternalId: null,
	dataBase64: 'AAAA'
};

const EMBED: MediaDescriptor = {
	id: 'm-2',
	kind: 'video-embed',
	key: null,
	filename: null,
	mime: null,
	size: null,
	width: null,
	height: null,
	alt: '',
	blurhash: null,
	videoProvider: 'youtube',
	videoExternalId: 'dQw4w9WgXcQ',
	dataBase64: null
};

function articleBundle(overrides: Record<string, unknown> = {}): unknown {
	return {
		version: CONTENT_BUNDLE_VERSION,
		type: 'article',
		pillars: ['somn'],
		media: [IMAGE, EMBED],
		article: {
			slug: 'un-articol',
			title: 'Un articol',
			excerpt: '',
			bodyMd: 'text',
			coverMediaId: 'm-1',
			status: 'published',
			publishedAt: '2026-07-01T00:00:00.000Z',
			seoTitle: null,
			seoDescription: null
		},
		...overrides
	};
}

// Fully-populated sample rows (`satisfies` keeps them honest against the
// schema: adding a column breaks these until the sample carries it too).
const ARTICLE_ROW = {
	id: 'a-1',
	slug: 'un-articol',
	title: 'Un articol',
	excerpt: 'Rezumat',
	bodyMd: 'Corp',
	coverMediaId: 'm-1',
	status: 'published',
	publishedAt: new Date('2026-07-01T00:00:00Z'),
	seoTitle: 'SEO',
	seoDescription: 'SEO desc',
	createdBy: 'u-1',
	createdAt: new Date('2026-06-01T00:00:00Z'),
	updatedAt: new Date('2026-06-02T00:00:00Z')
} satisfies typeof articles.$inferSelect;

const QUIZ_ROW = {
	id: 'q-1',
	slug: 'un-chestionar',
	title: 'Un chestionar',
	introMd: 'Intro',
	pillarId: 3,
	formSchema: { steps: [] },
	scoring: { questions: {}, bands: [] },
	status: 'draft',
	resultTemplateKey: 'quiz-result',
	createdBy: 'u-1',
	createdAt: new Date('2026-06-01T00:00:00Z'),
	updatedAt: new Date('2026-06-02T00:00:00Z')
} satisfies typeof quizzes.$inferSelect;

const PRODUCT_ROW = {
	id: 'p-1',
	slug: 'un-produs',
	name: 'Un produs',
	descriptionMd: 'Descriere',
	priceCents: 4990,
	currency: 'ron',
	stripeProductId: 'prod_x',
	stripePriceId: 'price_x',
	status: 'active',
	coverMediaId: 'm-1',
	gallery: ['m-1'],
	stock: 5,
	createdAt: new Date('2026-06-01T00:00:00Z'),
	updatedAt: new Date('2026-06-02T00:00:00Z')
} satisfies typeof products.$inferSelect;

const MEDIA_ROW = {
	id: 'm-1',
	kind: 'image',
	key: 'uploads/2026/07/test-abc.png',
	filename: 'test.png',
	mime: 'image/png',
	size: 3,
	width: 320,
	height: 200,
	alt: 'un test',
	blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
	videoProvider: null,
	videoExternalId: null,
	createdBy: 'u-1',
	createdAt: new Date('2026-06-01T00:00:00Z')
} satisfies typeof media.$inferSelect;

function bundledColumns(table: Table, excluded: readonly string[]): string[] {
	return Object.keys(getTableColumns(table))
		.filter((column) => !excluded.includes(column))
		.sort();
}

// The round-trip parity gate (audit Theme D): every persisted column must be
// represented in the bundle unless deliberately excluded. Fails when a column
// is added to a schema without threading it through the bundle mappers —
// exactly the drift that silently dropped `media.blurhash` before this test.
describe('bundle ↔ schema parity', () => {
	it('article content carries every articles column except the excluded set', () => {
		expect(Object.keys(articleToContent(ARTICLE_ROW)).sort()).toEqual(
			bundledColumns(articles, BUNDLE_EXCLUDED_COLUMNS.article)
		);
	});

	it('quiz content carries every quizzes column except the excluded set', () => {
		expect(Object.keys(quizToContent(QUIZ_ROW)).sort()).toEqual(
			bundledColumns(quizzes, BUNDLE_EXCLUDED_COLUMNS.quiz)
		);
	});

	it('product content carries every products column except the excluded set', () => {
		expect(Object.keys(productToContent(PRODUCT_ROW)).sort()).toEqual(
			bundledColumns(products, BUNDLE_EXCLUDED_COLUMNS.product)
		);
	});

	it('media descriptor carries every media column (plus the file bytes)', () => {
		expect(Object.keys(mediaToDescriptor(MEDIA_ROW, 'AAAA')).sort()).toEqual(
			[...bundledColumns(media, BUNDLE_EXCLUDED_COLUMNS.media), 'dataBase64'].sort()
		);
	});

	it('the descriptor preserves blurhash (dropped before the Theme D fix)', () => {
		expect(mediaToDescriptor(MEDIA_ROW, 'AAAA').blurhash).toBe(MEDIA_ROW.blurhash);
	});
});

describe('remapMediaRefs', () => {
	it('rewrites only refs present in the map', () => {
		const md = 'a ![x](media:old-id) b ![y](media:keep) c ![z](media:uploads/k.png)';
		const out = remapMediaRefs(md, new Map([['old-id', 'new-id']]));
		expect(out).toBe('a ![x](media:new-id) b ![y](media:keep) c ![z](media:uploads/k.png)');
	});

	it('preserves alt text and any trailing title segment', () => {
		const md = '![alt text](media:a "titlu")';
		expect(remapMediaRefs(md, new Map([['a', 'b']]))).toBe('![alt text](media:b "titlu")');
	});

	it('leaves markdown untouched with an empty map', () => {
		const md = '![x](media:a) plain ![](http://example.com/i.png)';
		expect(remapMediaRefs(md, new Map())).toBe(md);
	});
});

describe('parseBundle', () => {
	it('accepts a well-formed article bundle', () => {
		const parsed = parseBundle(articleBundle());
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.bundle.type).toBe('article');
			expect(parsed.bundle.media).toHaveLength(2);
		}
	});

	it('rejects non-objects, wrong versions and unknown types', () => {
		expect(parseBundle(null).ok).toBe(false);
		expect(parseBundle([]).ok).toBe(false);
		expect(parseBundle(articleBundle({ version: 99 })).ok).toBe(false);
		expect(parseBundle(articleBundle({ type: 'page' })).ok).toBe(false);
	});

	it('rejects image descriptors without bytes or key', () => {
		expect(parseBundle(articleBundle({ media: [{ ...IMAGE, dataBase64: null }] })).ok).toBe(false);
		expect(parseBundle(articleBundle({ media: [{ ...IMAGE, key: null }] })).ok).toBe(false);
	});

	it('rejects descriptors without a blurhash field (lossy pre-v2 bundles)', () => {
		const withoutBlurhash: Record<string, unknown> = { ...IMAGE };
		delete withoutBlurhash.blurhash;
		expect(parseBundle(articleBundle({ media: [withoutBlurhash] })).ok).toBe(false);
		expect(parseBundle(articleBundle({ media: [{ ...IMAGE, blurhash: 7 }] })).ok).toBe(false);
		expect(parseBundle(articleBundle({ media: [{ ...IMAGE, blurhash: null }] })).ok).toBe(true);
	});

	it('rejects video embeds with a key or unknown provider', () => {
		expect(parseBundle(articleBundle({ media: [{ ...EMBED, key: 'x' }] })).ok).toBe(false);
		expect(parseBundle(articleBundle({ media: [{ ...EMBED, videoProvider: 'vimeo' }] })).ok).toBe(
			false
		);
	});

	it('rejects a payload that does not match the declared type', () => {
		expect(parseBundle(articleBundle({ article: undefined })).ok).toBe(false);
		expect(parseBundle(articleBundle({ article: { slug: '' } })).ok).toBe(false);
		const quizWithoutPayload = { ...(articleBundle() as Record<string, unknown>), type: 'quiz' };
		expect(parseBundle(quizWithoutPayload).ok).toBe(false);
	});

	it('round-trips through JSON', () => {
		const parsed = parseBundle(JSON.parse(JSON.stringify(articleBundle())));
		expect(parsed.ok).toBe(true);
		const bundle = (parsed as { ok: true; bundle: ContentBundle }).bundle;
		expect(bundle.pillars).toEqual(['somn']);
	});
});
