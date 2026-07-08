import { env } from '$env/dynamic/private';
import { resolveSiteConfig, type SiteConfig } from '$lib/config';

let site: SiteConfig | undefined;

/** The active site's config, resolved once per process from SITE_ID (fails fast). */
export function getSite(): SiteConfig {
	site ??= resolveSiteConfig(env.SITE_ID);
	return site;
}
