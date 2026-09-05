import { env } from '$env/dynamic/public';

/**
 * Absolute canonical URL for a path, from PUBLIC_SITE_URL (the site's public
 * origin — NOT the request origin, which may be a preview host or proxy).
 */
export function canonicalUrl(path: string): string {
	const base = (env.PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
	return `${base}${path}`;
}

/** Serialize JSON-LD so it is safe to inline inside a <script> tag. */
export function jsonLdString(data: Record<string, unknown>): string {
	return JSON.stringify(data).replace(/</g, '\\u003c');
}

/**
 * `<link rel="alternate" hreflang>` entries for a page, or none (FIX-15).
 * Alternates are advertised only when they are TRUE: the site config lists
 * more than one locale (`SiteConfig.locales` is the single source — the same
 * list the newsletter/quiz subscriber locale comes from) AND paraglide's
 * runtime resolves the locale from the URL (`url` in its `strategy`), so a
 * localized href really renders that locale. Otherwise `/en/…` would be the
 * Romanian page with a canonical back to the base URL — a crawlable
 * duplicate tree with conflicting signals. Pure: the layout supplies hrefs.
 */
export function hreflangAlternates(
	siteLocales: readonly string[],
	strategy: readonly string[],
	baseLocale: string,
	hrefFor: (locale: string) => string
): Array<{ hreflang: string; href: string }> {
	if (siteLocales.length < 2 || !strategy.includes('url')) return [];
	return [
		...siteLocales.map((locale) => ({ hreflang: locale, href: hrefFor(locale) })),
		{ hreflang: 'x-default', href: hrefFor(baseLocale) }
	];
}
