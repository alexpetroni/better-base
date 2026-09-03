import { error } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { getStorage } from '$lib/modules/media/server';
import { ensureShipmentLabel, getCourierProvider, shipments } from '$lib/modules/shop/server';
import { requireAdmin } from '$lib/server/forms';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/**
 * AWB label download: `/api/shipments/<id>/label`. The invoice-document
 * pattern, minus the customer token: labels are an OPERATOR artifact (they go
 * on the parcel), so the only way in is an admin session — editor, anonymous
 * or foreign requests get 403 and no bytes. The label is fetched from the
 * courier on first request and stored write-once in the private S3 prefix, so
 * downloads survive courier-side label expiry.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	requireAdmin(locals);

	const db = getDb();
	const [shipment] = await db.select().from(shipments).where(eq(shipments.id, params.id));
	if (!shipment) error(404);

	const bytes = await ensureShipmentLabel(
		{ courier: getCourierProvider(), storage: getStorage() },
		shipment
	);
	if (!bytes) error(404);

	return new Response(new Uint8Array(bytes), {
		headers: {
			'content-type': 'application/pdf',
			'content-disposition': `attachment; filename="AWB-${shipment.awb}.pdf"`,
			'cache-control': 'private, no-store'
		}
	});
};
