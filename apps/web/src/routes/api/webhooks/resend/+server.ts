import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/db';
import { revokeConsentsByEmail } from '$lib/modules/crm/server';
import { parseResendEvent, verifyResendWebhook } from '$lib/modules/email/server';
import { cancelSubscriberNurture } from '$lib/modules/nurture/server';
import type { RequestHandler } from './$types';

/**
 * Resend webhook (audit 2026-09-03 P1): `email.bounced` and `email.complained`
 * withdraw the address exactly like an unsubscribe (all consents revoked,
 * double opt-in cleared, nurture cancelled) with the feedback kind as the
 * consent source. The Svix signature is verified over the RAW body; a missing
 * `RESEND_WEBHOOK_SECRET` answers 503 so an unconfigured deploy never falls
 * open. Idempotent: withdrawing an already-withdrawn address changes nothing.
 * Wiring: DEPLOYMENT.md §8.
 */
export const POST: RequestHandler = async ({ request }) => {
	const secret = env.RESEND_WEBHOOK_SECRET;
	if (!secret) {
		return json({ error: 'RESEND_WEBHOOK_SECRET is not set' }, { status: 503, headers: NO_STORE });
	}
	const payload = await request.text();
	if (!verifyResendWebhook(payload, request.headers, secret)) {
		return json({ error: 'Invalid webhook signature' }, { status: 400, headers: NO_STORE });
	}

	let body: unknown;
	try {
		body = JSON.parse(payload);
	} catch {
		return json({ error: 'Malformed JSON' }, { status: 400, headers: NO_STORE });
	}
	const event = parseResendEvent(body);
	if (!event) return json({ received: true, ignored: true }, { headers: NO_STORE });

	const db = getDb();
	let revoked = 0;
	for (const email of event.emails) {
		const subscriber = await revokeConsentsByEmail({ db }, email, event.kind);
		if (!subscriber) continue;
		await cancelSubscriberNurture({ db }, subscriber.id);
		revoked += 1;
	}
	console.log(
		`resend-webhook kind=${event.kind} recipients=${event.emails.length} revoked=${revoked}`
	);
	return json({ received: true, kind: event.kind, revoked }, { headers: NO_STORE });
};

const NO_STORE = { 'cache-control': 'no-store' };
