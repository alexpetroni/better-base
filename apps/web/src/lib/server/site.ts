import { env } from '$env/dynamic/private';
import { PILLARS_BY_SLUG, resolveSiteConfig, type SiteConfig } from '$lib/config';

let site: SiteConfig | undefined;

/** The active site's config, resolved once per process from SITE_ID (fails fast). */
export function getSite(): SiteConfig {
	site ??= resolveSiteConfig(env.SITE_ID);
	return site;
}

/** The active site's pillars as `{ slug, name }`, for pillar pickers and filters. */
export function resolveSitePillars(): Array<{ slug: string; name: string }> {
	return getSite().pillars.map((slug) => ({
		slug,
		name: PILLARS_BY_SLUG.get(slug)?.name ?? slug
	}));
}
