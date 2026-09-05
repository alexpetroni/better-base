// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { StaffRole } from '$lib/modules/auth';
import type { SiteSettings } from '$lib/modules/settings';

declare global {
	/** Git commit of this build, injected by vite `define` (vite.config.ts) — see /api/health. */
	const __BUILD_COMMIT__: string;

	namespace App {
		interface Error {
			message: string;
			/** Correlates the user-visible error with the structured server log line. */
			errorId?: string;
			/** The request's `x-request-id` (FIX-16) — the same key the log line carries. */
			requestId?: string;
		}
		interface Locals {
			/** Authenticated staff user, resolved by hooks.server.ts on /admin requests. */
			user: {
				id: string;
				email: string;
				name: string;
				role: StaffRole;
			} | null;
			/**
			 * Lazy request-scoped site settings, set by hooks.server.ts: memoized
			 * per request, so any number of loads share one query. Expose values
			 * to the client ONLY via `clientSafeSettings(...)`.
			 */
			settings: () => Promise<SiteSettings>;
			/**
			 * Per-request correlation id (FIX-16): `x-vercel-id` on Vercel, a UUID
			 * elsewhere. Echoed as the `x-request-id` response header.
			 */
			requestId: string;
		}
		interface PageData {
			/**
			 * Header cart badge count. Set by the public layout load; a page that
			 * mutates the cart cookie in its own load (checkout success) overrides
			 * it, because the layout load may have read the cookie before the
			 * mutation in the same request.
			 */
			cartCount?: number;
		}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
