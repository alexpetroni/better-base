import { describe, expect, it } from 'vitest';
import {
	CONTENT_BUNDLE_VERSION,
	parseBundle,
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
