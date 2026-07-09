/**
 * The `![alt](media:<id-or-key>)` reference convention shared by the blog
 * markdown pipeline, the shop description scan and the content export CLI.
 * Pure string parsing — resolution against the media table stays with the
 * callers.
 */

export const MEDIA_REF_PREFIX = 'media:';

/** All `media:` refs mentioned as image targets: `![alt](media:REF)`. */
export function extractMediaRefs(md: string): string[] {
	const refs = new Set<string>();
	for (const match of md.matchAll(/!\[[^\]]*\]\(media:([^)\s]+)(?:\s[^)]*)?\)/g)) {
		refs.add(match[1]);
	}
	return [...refs];
}
