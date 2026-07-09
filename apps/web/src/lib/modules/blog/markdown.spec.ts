import { describe, expect, it } from 'vitest';
import type { ImageSources } from '../media/imgproxy.ts';
import { extractMediaRefs } from '../../util/media-refs.ts';
import { renderMarkdown, type MediaResolver } from './markdown.ts';

const SOURCES: ImageSources = {
	src: 'http://img.example/sig/rs:fit:768:0/plain/s3:%2F%2Fb/k@webp',
	srcsetWebp: 'http://img.example/a 1x, http://img.example/b 2x',
	srcsetAvif: 'http://img.example/c 1x, http://img.example/d 2x',
	width: 768,
	height: 480,
	alt: 'Alt din librărie'
};

const resolver: MediaResolver = (ref) => {
	if (ref === 'img-1' || ref === 'uploads/2026/07/poza.webp') {
		return { kind: 'image', sources: SOURCES };
	}
	if (ref === 'vid-1') return { kind: 'video', provider: 'youtube', externalId: 'dQw4w9WgXcQ' };
	if (ref === 'vid-bunny') return { kind: 'video', provider: 'bunny', externalId: '123/abc-def' };
	if (ref === 'vid-evil') return { kind: 'video', provider: 'youtube', externalId: '"><script>' };
	return null;
};

describe('sanitization', () => {
	it('strips script tags', () => {
		const html = renderMarkdown('hello\n\n<script>alert(1)</script>\n\nworld');
		expect(html).not.toContain('<script');
		expect(html).not.toContain('alert(1)');
		expect(html).toContain('<p>hello</p>');
	});

	it('strips event handler attributes', () => {
		const html = renderMarkdown('<img src="http://x.example/a.png" onerror="alert(1)" />');
		expect(html).not.toContain('onerror');
		expect(html).toContain('<img src="http://x.example/a.png"');
	});

	it('strips javascript: URLs from links', () => {
		const html = renderMarkdown('[click](javascript:alert(1))');
		expect(html).not.toContain('javascript:');
	});

	it('strips javascript: URLs from raw html images', () => {
		const html = renderMarkdown('<img src="javascript:alert(1)">');
		expect(html).not.toContain('javascript:');
	});

	it('strips iframes pointing at unknown hosts', () => {
		const html = renderMarkdown('<iframe src="https://evil.example/x"></iframe>');
		expect(html).not.toContain('evil.example');
		expect(html).not.toContain('<iframe');
	});

	it('strips style tags and inline event-laden markup wholesale', () => {
		const html = renderMarkdown('<style>body{}</style><a href="#" onclick="x()">a</a>');
		expect(html).not.toContain('<style');
		expect(html).not.toContain('onclick');
	});

	it('keeps ordinary markdown structure', () => {
		const html = renderMarkdown('# Titlu\n\n- unu\n- doi\n\n**bold** [link](https://x.ro)');
		expect(html).toContain('<h1>Titlu</h1>');
		expect(html).toContain('<li>unu</li>');
		expect(html).toContain('<strong>bold</strong>');
		expect(html).toContain('<a href="https://x.ro">link</a>');
	});
});

describe('media references', () => {
	it('extracts refs from image syntax', () => {
		const md =
			'![a](media:img-1) text ![b](media:vid-1) ![c](https://x.ro/i.png) ![d](media:img-1)';
		expect(extractMediaRefs(md).sort()).toEqual(['img-1', 'vid-1']);
	});

	it('renders an image ref as picture markup with avif/webp srcsets', () => {
		const html = renderMarkdown('![O poză](media:img-1)', resolver);
		expect(html).toContain('<picture>');
		expect(html).toContain('type="image/avif"');
		expect(html).toContain('type="image/webp"');
		expect(html).toContain('loading="lazy"');
		expect(html).toContain('width="768"');
		// Width-descriptor srcsets are inert without a sizes attribute.
		expect(html).toContain('sizes="768px"');
		expect(html).toContain('alt="O poză"');
	});

	it('resolves refs by storage key too', () => {
		const html = renderMarkdown('![](media:uploads/2026/07/poza.webp)', resolver);
		expect(html).toContain('<picture>');
		// No author alt → the library row's alt is used.
		expect(html).toContain('alt="Alt din librărie"');
	});

	it('renders unresolved refs as nothing (no broken img)', () => {
		const html = renderMarkdown('before ![x](media:missing) after', resolver);
		expect(html).not.toContain('<img');
		expect(html).not.toContain('media:missing');
		expect(html).toContain('before');
	});

	it('renders a youtube video-embed row as a nocookie iframe', () => {
		const html = renderMarkdown('![Un video](media:vid-1)', resolver);
		expect(html).toContain('<iframe');
		expect(html).toContain('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
		expect(html).toContain('title="Un video"');
	});

	it('renders a bunny video-embed row via iframe.mediadelivery.net', () => {
		const html = renderMarkdown('![v](media:vid-bunny)', resolver);
		expect(html).toContain('https://iframe.mediadelivery.net/embed/123/abc-def');
	});

	it('drops video embeds whose external id contains unsafe characters', () => {
		const html = renderMarkdown('![v](media:vid-evil)', resolver);
		expect(html).not.toContain('<iframe');
		expect(html).not.toContain('<script');
	});

	it('leaves plain external images to default rendering', () => {
		const html = renderMarkdown('![alt extern](https://x.ro/i.png)', resolver);
		expect(html).toContain('<img src="https://x.ro/i.png" alt="alt extern"');
	});
});
