export interface NavItem {
	label: string;
	href: string;
}

export interface SiteConfig {
	id: string;
	name: string;
	domain: string;
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
}
