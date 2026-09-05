/**
 * The `![alt](media:<id-or-key>)` reference convention shared by the blog
 * markdown pipeline, the shop description scan and the content export CLI.
 * Pure string parsing — resolution against the media table stays with the
 * callers.
 */

export const MEDIA_REF_PREFIX = 'media:';

/**
 * Regex (Postgres ARE and JS compatible) matching a markdown image ref to
 * exactly this id or key — with or without a title segment:
 * `(media:REF)` and `(media:REF "title")` match, `(media:REF2)` does not
 * (FIX-15: the old `LIKE '%(media:REF)%'` guard missed titled refs, so the
 * library could delete an image an article still embedded). Use as
 * `column ~ mediaRefPattern(ref)`.
 */
export function mediaRefPattern(ref: string): string {
	const escaped = ref.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
	return `\\(${MEDIA_REF_PREFIX}${escaped}[\\s)]`;
}

/** All `media:` refs mentioned as image targets: `![alt](media:REF)`. */
export function extractMediaRefs(md: string): string[] {
	const refs = new Set<string>();
	for (const match of md.matchAll(/!\[[^\]]*\]\(media:([^)\s]+)(?:\s[^)]*)?\)/g)) {
		refs.add(match[1]);
	}
	return [...refs];
}
