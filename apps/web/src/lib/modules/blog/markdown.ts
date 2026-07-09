import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { MEDIA_REF_PREFIX } from '../../util/media-refs.ts';
import type { ImageSources } from '../media/imgproxy.ts';

/**
 * Markdown → sanitized HTML, pure and unit-testable offline. Media lookups
 * are injected: the caller (see render.ts) resolves `media:` references to
 * signed imgproxy sources or video embeds before rendering.
 *
 * Security: the OUTPUT is always passed through sanitize-html with a strict
 * allowlist — scripts, event handlers, `javascript:` URLs and iframes to
 * unknown hosts are stripped no matter what the markdown contains.
 */

export type MediaEmbed =
	| { kind: 'image'; sources: ImageSources }
	| { kind: 'video'; provider: 'youtube' | 'bunny'; externalId: string };

export type MediaResolver = (ref: string) => MediaEmbed | null;

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/** `<Img>`-equivalent picture markup (avif/webp srcsets, lazy img). */
export function pictureHtml(sources: ImageSources, altOverride?: string): string {
	const alt = escapeHtml(altOverride || sources.alt);
	const dims =
		sources.width && sources.height ? ` width="${sources.width}" height="${sources.height}"` : '';
	// Width-descriptor srcsets need a `sizes`; the layout width mirrors <Img>'s
	// default (article images render at their requested width inside the prose).
	const sizes = sources.width ? ` sizes="${sources.width}px"` : '';
	const avif = sources.srcsetAvif
		? `<source type="image/avif" srcset="${escapeHtml(sources.srcsetAvif)}"${sizes} />`
		: '';
	const webp = sources.srcsetWebp
		? `<source type="image/webp" srcset="${escapeHtml(sources.srcsetWebp)}"${sizes} />`
		: '';
	return `<picture>${avif}${webp}<img src="${escapeHtml(sources.src)}" alt="${alt}"${dims} loading="lazy" decoding="async" /></picture>`;
}

// Only safe path characters may enter an embed URL; anything else drops the embed.
const VIDEO_ID_RE = /^[A-Za-z0-9_/-]+$/;

export function videoEmbedHtml(
	provider: 'youtube' | 'bunny',
	externalId: string,
	title: string
): string {
	if (!VIDEO_ID_RE.test(externalId)) return '';
	const src =
		provider === 'youtube'
			? `https://www.youtube-nocookie.com/embed/${externalId}`
			: `https://iframe.mediadelivery.net/embed/${externalId}`;
	return `<iframe class="video-embed" src="${src}" title="${escapeHtml(title)}" loading="lazy" allowfullscreen referrerpolicy="no-referrer"></iframe>`;
}

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
	allowedTags: [
		'h1',
		'h2',
		'h3',
		'h4',
		'p',
		'ul',
		'ol',
		'li',
		'blockquote',
		'pre',
		'code',
		'strong',
		'em',
		'del',
		'hr',
		'br',
		'a',
		'img',
		'picture',
		'source',
		'figure',
		'figcaption',
		'table',
		'thead',
		'tbody',
		'tr',
		'th',
		'td',
		'iframe'
	],
	allowedAttributes: {
		a: ['href', 'title', 'rel'],
		img: ['src', 'srcset', 'sizes', 'alt', 'title', 'width', 'height', 'loading', 'decoding'],
		source: ['srcset', 'sizes', 'type'],
		code: ['class'],
		iframe: ['src', 'title', 'class', 'loading', 'allowfullscreen', 'referrerpolicy']
	},
	allowedSchemes: ['http', 'https', 'mailto'],
	allowProtocolRelative: false,
	allowedIframeHostnames: ['www.youtube-nocookie.com', 'iframe.mediadelivery.net'],
	disallowedTagsMode: 'discard',
	// A disallowed iframe src is stripped attribute-wise; drop the empty shell too.
	exclusiveFilter: (frame) => frame.tag === 'iframe' && !frame.attribs.src
};

/** Render markdown to sanitized HTML. `resolveMedia` handles `media:` image refs. */
export function renderMarkdown(md: string, resolveMedia: MediaResolver = () => null): string {
	const marked = new Marked({
		renderer: {
			image({ href, text }) {
				if (!href?.startsWith(MEDIA_REF_PREFIX)) return false;
				const embed = resolveMedia(href.slice(MEDIA_REF_PREFIX.length));
				// An unresolved reference (deleted media, typo) renders as nothing
				// rather than a broken image.
				if (!embed) return '';
				if (embed.kind === 'image') return pictureHtml(embed.sources, text);
				return videoEmbedHtml(embed.provider, embed.externalId, text);
			}
		}
	});
	const html = marked.parse(md, { async: false });
	return sanitizeHtml(html, SANITIZE_OPTIONS);
}
