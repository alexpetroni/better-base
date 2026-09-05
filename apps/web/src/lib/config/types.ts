import type { NurtureSequenceDefinition } from '$lib/modules/nurture';

export interface NavItem {
	label: string;
	href: string;
}

export interface SiteConfig {
	id: string;
	name: string;
	domain: string;
	/**
	 * Locales the site really serves (data, not paraglide's compiled list).
	 * Single source for the subscriber locale and for hreflang alternates —
	 * which are emitted only for more than one locale AND a URL-based
	 * paraglide strategy (FIX-15, `hreflangAlternates`).
	 */
	locales: string[];
	/** Slugs of the active pillars; must exist in `CANONICAL_PILLARS`. */
	pillars: string[];
	/** CSS custom property name (without `--`) -> value. Applied on <html> by the root layout. */
	theme: Record<string, string>;
	nav: NavItem[];
	/** Footer links (legal pages etc.) — rendered on every public page. */
	footerLinks: NavItem[];
	chatPersonaKey: string;
	/** Whether the floating chat widget is rendered on public pages. */
	chatWidget: boolean;
	email: {
		from: string;
		replyTo: string;
	};
	/**
	 * Nurture sequence definitions seeded into `nurture_sequences` rows by
	 * `pnpm db:seed` (upsert by key; the operator's active flag survives).
	 * Sequences are DATA — the two sites differ here, not in code.
	 */
	nurture: NurtureSequenceDefinition[];
}
