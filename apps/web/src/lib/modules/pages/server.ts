// Server module barrel: schema + db services for simple pages.
export { pages, type PageRow } from './schema.ts';
export { DEFAULT_PAGES, PRIVACY_PAGE_SLUG, TERMS_PAGE_SLUG } from './seed-pages.ts';
export {
	createPage,
	ensurePage,
	getPage,
	getPageBySlug,
	listPages,
	updatePage,
	type PagesDeps,
	type PagesResult
} from './service.ts';
