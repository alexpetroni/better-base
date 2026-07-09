// Universal barrel: pure template rendering and types only. Everything that
// touches the db or env lives in ./server.
export {
	EMAIL_TEMPLATE_KEYS,
	escapeHtml,
	renderEmailTemplate,
	type RenderedEmail,
	type TemplateData,
	type TemplateKey
} from './templates.ts';
