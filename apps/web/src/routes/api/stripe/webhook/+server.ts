import { error, json } from '@sveltejs/kit';
import { env as publicEnv } from '$env/dynamic/public';
import { getDb } from '$lib/db';
import { getEmailSender } from '$lib/modules/email/server';
import { invoicePdfAttachmentForOrder } from '$lib/modules/invoice/server';
import { getInvoiceStorage } from '$lib/modules/media/server';
import {
	getCourierProvider,
	getStripeWebhookSecret,
	processStripeEvent,
	verifyStripeEvent
} from '$lib/modules/shop/server';
import { getSite } from '$lib/server/site';
import type { RequestHandler } from './$types';

/**
 * Stripe webhook endpoint. The signature is verified over the RAW body —
 * any tampering (or a missing/foreign secret) is a 400 and nothing is
 * processed. Event handling itself is idempotent (see modules/shop/webhook).
 */
export const POST: RequestHandler = async ({ request }) => {
	const signature = request.headers.get('stripe-signature');
	if (!signature) error(400, 'Missing stripe-signature header');

	const payload = await request.text();
	let event;
	try {
		event = await verifyStripeEvent(payload, signature, getStripeWebhookSecret());
	} catch {
		error(400, 'Invalid webhook signature');
	}

	const outcome = await processStripeEvent(
		{
			db: getDb(),
			email: getEmailSender(),
			siteName: getSite().name,
			// getInvoiceStorage() resolves inside the callback: a missing S3 config
			// surfaces as a caught attachment failure, never a dead webhook.
			invoiceAttachment: (orderId) =>
				invoicePdfAttachmentForOrder({ db: getDb(), storage: getInvoiceStorage() }, orderId),
			publicBaseUrl: publicEnv.PUBLIC_SITE_URL,
			// Refunds cancel a not-yet-picked-up AWB with the courier (best effort).
			courier: getCourierProvider()
		},
		event
	);
	return json({ received: true, outcome: outcome.kind });
};
