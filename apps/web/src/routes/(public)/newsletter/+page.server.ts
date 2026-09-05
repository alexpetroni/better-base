import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { getDb } from '$lib/db';
import { CONSENT_TEXT_VERSIONS } from '$lib/modules/crm';
import { getTokenSecret, requestNewsletterSignup } from '$lib/modules/crm/server';
import { getEmailSender } from '$lib/modules/email/server';
import { consumePublicEmailBudget } from '$lib/server/rate-limit';
import { getSite } from '$lib/server/site';
import type { Actions } from './$types';

// The footer/blog NewsletterSignup components POST here (plain form posts, so
// signup works without JS from any public page and the outcome renders here).
export const actions: Actions = {
	default: async ({ request, getClientAddress }) => {
		const form = await request.formData();
		// GDPR: no consent checkbox, no signup — the checkbox is required
		// client-side, but never trust the browser.
		if (form.get('newsletter_consent') !== 'yes') {
			return fail(400, { error: 'consent' as const });
		}
		// This endpoint emails a visitor-supplied address: throttle per IP and
		// globally before doing anything (a CAPTCHA check would slot in here —
		// see $lib/server/rate-limit/public-email.ts).
		const budget = await consumePublicEmailBudget(getDb(), 'newsletter', getClientAddress());
		if (budget.limited) return fail(429, { error: 'rate_limited' as const });
		const site = getSite();
		const source = String(form.get('source') ?? 'footer');
		const outcome = await requestNewsletterSignup(
			{
				db: getDb(),
				email: getEmailSender(),
				secret: getTokenSecret(),
				baseUrl: (env.PUBLIC_SITE_URL ?? '').replace(/\/$/, ''),
				siteName: site.name
			},
			{
				email: String(form.get('email') ?? ''),
				locale: site.locales[0],
				source: source.slice(0, 64),
				// Proof of the grant: who agreed, from which client, to which copy.
				evidence: {
					ip: getClientAddress(),
					userAgent: request.headers.get('user-agent')?.slice(0, 256) || undefined,
					consentTextVersion: { newsletter: CONSENT_TEXT_VERSIONS.newsletter }
				}
			}
		);
		if (!outcome.ok) return fail(400, { error: 'email' as const });
		// ONE answer for new and existing addresses: "already subscribed" was a
		// confirmed-status oracle (audit 2026-09-03 P1). A confirmed address
		// simply receives no second confirm email.
		return { status: 'sent' as const };
	}
};
