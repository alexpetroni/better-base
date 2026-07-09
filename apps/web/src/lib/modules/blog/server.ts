// Server module barrel: services and rendering glue. The articles media
// reference check is exported here and wired into deleteMedia via
// $lib/server/media-library.ts MEDIA_REFERENCE_CHECKS.
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
