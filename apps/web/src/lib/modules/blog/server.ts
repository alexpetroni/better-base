// Server module barrel: services, rendering glue and the media reference
// check registration. Loaded from hooks.server.ts so the registration below
// runs before any admin request can delete media.
import { registerMediaReferenceCheck } from '$lib/modules/media/server';
import { articlesMediaReferenceCheck } from './media-ref.ts';

export { articlesMediaReferenceCheck } from './media-ref.ts';
export {
	extractMediaRefs,
	pictureHtml,
	renderMarkdown,
	videoEmbedHtml,
	type MediaEmbed,
	type MediaResolver
} from './markdown.ts';
export { ARTICLE_IMAGE_WIDTH, renderArticleHtml } from './render.ts';
export { articlePillars, articles } from './schema.ts';
export {
	createArticle,
	DEFAULT_PAGE_SIZE,
	ensureUniqueSlug,
	getArticle,
	getBySlug,
	listArticles,
	listPublished,
	listPublishedForSitemap,
	publishArticle,
	unpublishArticle,
	updateArticle,
	type ArticlePatch,
	type ArticleWithPillars,
	type BlogDeps,
	type BlogError,
	type BlogResult,
	type PublishedList
} from './service.ts';

registerMediaReferenceCheck(articlesMediaReferenceCheck);
