import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/db';
import { getEFacturaSubmitter, submitPendingEFactura } from '$lib/modules/invoice/server';
import { getInvoiceStorage } from '$lib/modules/media/server';
import { authorizeCron } from '$lib/server/cron';
import type { RequestHandler } from './$types';

/**
 * e-Factura submission drain as an HTTP job (the shipment-sync pattern):
 * scheduled in `vercel.json`, guarded by `authorizeCron`; the machine-cron
 * equivalent is in DEPLOYMENT.md §9. Claims due `invoice_submissions` rows
 * (FOR UPDATE SKIP LOCKED — two overlapping ticks never share a row),
 * renders the XML into the fiscal bucket and submits through the
 * `EFacturaSubmitter` seam. With no ANAF enrollment (today's default) every
 * row is `skipped` and stays pending for the manual SPV upload; the admin
 * "de trimis la ANAF" filter shows the days left.
 */
export const GET: RequestHandler = async ({ request }) => {
	const auth = authorizeCron(request.headers.get('authorization'), env.CRON_SECRET);
	if (!auth.ok) {
		return json({ error: auth.reason }, { status: auth.status, headers: NO_STORE });
	}

	const result = await submitPendingEFactura({
		db: getDb(),
		storage: getInvoiceStorage(),
		efactura: getEFacturaSubmitter()
	});
	console.log(
		`efactura-submit claimed=${result.claimed} submitted=${result.submitted} ` +
			`skipped=${result.skipped} retried=${result.retried} parked=${result.parked}`
	);
	return json(result, { headers: NO_STORE });
};

const NO_STORE = { 'cache-control': 'no-store' };
