import sanitizeHtml from 'sanitize-html';

/**
 * SVG sanitization, pure and unit-testable offline.
 *
 * An uploaded SVG is active content: it can carry `<script>`, `onload=`,
 * `javascript:` hrefs and remote `<image>`/`<use>` references. imgproxy used to
 * strip those on every serve (`IMGPROXY_SANITIZE_SVG`), but the Cloudflare and
 * direct providers hand the stored object to the browser untouched — so the
 * stripping moves to CONFIRM time, once, at rest (audit M1).
 *
 * That is a strict improvement on the old arrangement: the dangerous bytes
 * never survive in the bucket at all, rather than being cleaned on the way out
 * by whichever component happened to be in front. Serving still adds
 * `Content-Disposition: attachment` as the second layer.
 */

/** Elements an illustration/logo legitimately needs. Everything else is dropped. */
const ALLOWED_TAGS = [
	'svg',
	'g',
	'defs',
	'title',
	'desc',
	'symbol',
	'use',
	'path',
	'rect',
	'circle',
	'ellipse',
	'line',
	'polyline',
	'polygon',
	'text',
	'tspan',
	'clipPath',
	'mask',
	'pattern',
	'marker',
	'linearGradient',
	'radialGradient',
	'stop',
	'filter',
	'feBlend',
	'feColorMatrix',
	'feComposite',
	'feFlood',
	'feGaussianBlur',
	'feMerge',
	'feMergeNode',
	'feOffset'
	// No `style`: its body is free-form CSS — `@import url(…)`, `url(http…)`
	// fetch remote resources (FIX-15). Presentation attributes cover artwork.
];

/**
 * Presentation attributes only. Notably absent: every `on*` handler (sanitize-
 * html drops unlisted attributes, so no denylist to keep current), `href`, and
 * `xlink:href` — a remote reference in an SVG is both an XSS vector and a
 * privacy leak, and our uploads are self-contained artwork.
 */
const ALLOWED_ATTRS = [
	'id',
	'class',
	'width',
	'height',
	'viewBox',
	'viewbox',
	'xmlns',
	'xmlns:xlink',
	'version',
	'preserveAspectRatio',
	'preserveaspectratio',
	'x',
	'y',
	'x1',
	'y1',
	'x2',
	'y2',
	'cx',
	'cy',
	'r',
	'rx',
	'ry',
	'd',
	'points',
	'transform',
	'fill',
	'fill-rule',
	'fill-opacity',
	'stroke',
	'stroke-width',
	'stroke-linecap',
	'stroke-linejoin',
	'stroke-dasharray',
	'stroke-opacity',
	'opacity',
	'style',
	'offset',
	'stop-color',
	'stop-opacity',
	'gradientUnits',
	'gradientunits',
	'gradientTransform',
	'gradienttransform',
	'clip-path',
	'clip-rule',
	'mask',
	'filter',
	'font-family',
	'font-size',
	'font-weight',
	'text-anchor',
	'dominant-baseline'
];

/**
 * Strip everything executable from an SVG document. Returns the cleaned
 * markup; the caller decides whether a document that lost content is still
 * worth storing (it always is — an illustration minus its script is a working
 * illustration).
 */
export function sanitizeSvg(source: string): string {
	return sanitizeHtml(source, {
		allowedTags: ALLOWED_TAGS,
		allowedAttributes: { '*': ALLOWED_ATTRS },
		allowedSchemes: [],
		allowVulnerableTags: false,
		parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
		transformTags: { '*': dropRemoteReferences }
	});
}

/**
 * An allowed attribute can still name a remote resource through CSS syntax:
 * `style="fill:url(https://…)"`, `fill="url(https://…)"`, `@import`. Local
 * `url(#id)` references (gradients, clip paths, markers) are what artwork
 * uses, so only those survive.
 */
const REMOTE_CSS_REF = /@import|url\s*\(\s*['"]?\s*(?!#)/i;

function dropRemoteReferences(
	tagName: string,
	attribs: Record<string, string>
): { tagName: string; attribs: Record<string, string> } {
	for (const [name, value] of Object.entries(attribs)) {
		if (REMOTE_CSS_REF.test(value)) delete attribs[name];
	}
	return { tagName, attribs };
}

/** Cheap sniff for "this really is an SVG document" before sanitizing. */
export function looksLikeSvg(source: string): boolean {
	return /<svg[\s>]/i.test(source);
}
