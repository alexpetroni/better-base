// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { StaffRole } from '$lib/modules/auth';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** Authenticated staff user, resolved by hooks.server.ts on /admin requests. */
			user: {
				id: string;
				email: string;
				name: string;
				role: StaffRole;
			} | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
