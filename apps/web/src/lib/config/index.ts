import { PILLARS_BY_SLUG } from './pillars.ts';
import { sleepSite } from './sites/sleep.ts';
import { lifeSite } from './sites/life.ts';
import type { SiteConfig } from './types.ts';

export type { SiteConfig, NavItem } from './types.ts';
export { CANONICAL_PILLARS, PILLARS_BY_SLUG, type PillarDef } from './pillars.ts';

const SITES: Record<string, SiteConfig> = {
	[sleepSite.id]: sleepSite,
	[lifeSite.id]: lifeSite
};

/**
 * Resolve a site config from a SITE_ID value. Fails fast: a missing or unknown
 * id, or a config referencing a non-canonical pillar, is a startup error.
 */
export function resolveSiteConfig(siteId: string | undefined | null): SiteConfig {
	if (!siteId) {
		throw new Error('SITE_ID is not set. Set SITE_ID to one of: ' + Object.keys(SITES).join(', '));
	}
	const config = SITES[siteId];
	if (!config) {
		throw new Error(
			`Unknown SITE_ID "${siteId}". Expected one of: ` + Object.keys(SITES).join(', ')
		);
	}
	for (const slug of config.pillars) {
		if (!PILLARS_BY_SLUG.has(slug)) {
			throw new Error(`Site "${siteId}" references unknown pillar slug "${slug}"`);
		}
	}
	return config;
}
