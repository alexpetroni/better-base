import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import {
	listParkedSends,
	listSequencesWithStats,
	setSequenceActive
} from '$lib/modules/nurture/server';
import type { Actions, PageServerLoad } from './$types';

// Admin-only section (enforced by the /admin hook guard via ADMIN_ONLY_SECTIONS).
export const load: PageServerLoad = async () => {
	const deps = { db: getDb() };
	return {
		sequences: await listSequencesWithStats(deps),
		parked: await listParkedSends(deps)
	};
};

export const actions: Actions = {
	// The operator's kill switch: stop (or resume) a sequence without a
	// deploy. Pending sends pause in place — the drain only claims sends of
	// active sequences.
	toggle: async ({ request, locals }) => {
		// Defense in depth on a mutating action (the hook already gates the section).
		if (locals.user?.role !== 'admin') error(403);
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const active = String(form.get('active') ?? '');
		if (!id || (active !== 'true' && active !== 'false')) {
			return fail(400, { toggleError: 'invalid' as const });
		}
		const found = await setSequenceActive({ db: getDb() }, id, active === 'true');
		if (!found) return fail(400, { toggleError: 'not-found' as const });
		return { toggled: true };
	}
};
