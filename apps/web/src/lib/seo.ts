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
