/**
 * Pure gating rules for the analytics script. Consent is the primary gate
 * (`analyticsAllowed` — the hook point left by the gdpr module); path
 * exclusion is defense in depth: the loader is only mounted by the (public)
 * layout, so admin/api routes are structurally untracked, and this guard
 * keeps that true even if the loader is ever mounted somewhere broader.
 */
import { analyticsAllowed, type CookieConsentValue } from '$lib/modules/gdpr';
import type { AnalyticsScriptConfig } from './select.ts';

const UNTRACKED_PREFIXES = ['/admin', '/api'] as const;

export function isTrackablePath(pathname: string): boolean {
	return !UNTRACKED_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
	);
}

export function shouldLoadAnalytics(
	config: AnalyticsScriptConfig | null,
	decision: CookieConsentValue | null,
	pathname: string
): boolean {
	return config !== null && analyticsAllowed(decision) && isTrackablePath(pathname);
}
