// Universal module barrel: safe to import from components and client code.
// Services, rendering and everything db-bound live behind
// `$lib/modules/blog/server` instead.
export { extractMediaRefs, MEDIA_REF_PREFIX } from './markdown.ts';
export type { ArticleRow, ArticleStatus } from './schema.ts';
export { nextUniqueSlug, slugify } from './slug.ts';
