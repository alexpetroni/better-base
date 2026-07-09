// Content export/import: the cross-site content sharing mechanism.
// Node-safe (no $env/$app anywhere in this module) — the `pnpm content` CLI
// script imports these files relatively under plain node.
export {
	BUNDLE_EXCLUDED_COLUMNS,
	CONTENT_BUNDLE_VERSION,
	CONTENT_TYPES,
	articleToContent,
	isContentType,
	mediaToDescriptor,
	parseBundle,
	productToContent,
	quizToContent,
	remapMediaRefs,
	type ArticleContent,
	type ContentBundle,
	type ContentType,
	type MediaDescriptor,
	type ProductContent,
	type QuizContent
} from './bundle.ts';
export {
	exportContent,
	type ContentDeps,
	type ContentError,
	type ContentResult
} from './export.ts';
export { importContent, type ImportSummary } from './import.ts';
