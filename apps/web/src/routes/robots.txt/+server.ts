import { canonicalUrl } from '$lib/seo';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	const body = `User-agent: *
Allow: /
Disallow: /admin

Sitemap: ${canonicalUrl('/sitemap.xml')}
`;
	return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
