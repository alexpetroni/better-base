// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { StaffRole } from '$lib/modules/auth';

declare global {
	namespace App {
		interface Error {
			message: string;
			/** Correlates the user-visible error with the structured server log line. */
			errorId?: string;
		}
		interface Locals {
			/** Authenticated staff user, resolved by hooks.server.ts on /admin requests. */
			user: {
				id: string;
				email: string;
				name: string;
				role: StaffRole;
			} | null;
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
