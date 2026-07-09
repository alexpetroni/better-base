import { inArray, or } from 'drizzle-orm';
import { imageSources, type ImgproxyConfig } from '$lib/modules/media/server';
import { media, type MediaRow } from '../media/schema.ts';
import type { BlogDeps } from './service.ts';
import { extractMediaRefs } from '../../util/media-refs.ts';
import { renderMarkdown, type MediaEmbed } from './markdown.ts';

/** Rendered display width of in-article images (page column is ~768px). */
export const ARTICLE_IMAGE_WIDTH = 768;

function toEmbed(cfg: ImgproxyConfig, row: MediaRow): MediaEmbed | null {
	if (row.kind === 'video-embed' && row.videoProvider && row.videoExternalId) {
		return { kind: 'video', provider: row.videoProvider, externalId: row.videoExternalId };
	}
	if (row.key) {
		return { kind: 'image', sources: imageSources(cfg, row, { w: ARTICLE_IMAGE_WIDTH }) };
	}
	return null;
}

/**
 * Render an article body: resolve every `media:` reference (by media row id
 * or storage key) against the database, then produce sanitized HTML with
 * signed imgproxy picture markup / video iframes.
 */
export async function renderArticleHtml(
	deps: BlogDeps,
	cfg: ImgproxyConfig,
	bodyMd: string
): Promise<string> {
	const refs = extractMediaRefs(bodyMd);
	const byRef = new Map<string, MediaRow>();
	if (refs.length) {
		const rows = await deps.db
			.select()
			.from(media)
			.where(or(inArray(media.id, refs), inArray(media.key, refs)));
		for (const row of rows) {
			byRef.set(row.id, row);
			if (row.key) byRef.set(row.key, row);
		}
	}
	return renderMarkdown(bodyMd, (ref) => {
		const row = byRef.get(ref);
		return row ? toEmbed(cfg, row) : null;
	});
}
