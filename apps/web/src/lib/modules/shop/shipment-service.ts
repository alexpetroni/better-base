import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import type { DbTx } from '../../server/event-ledger/core.ts';
import type { Result } from '../../util/result.ts';
import type { EmailSender } from '../email/service.ts';
import type { Storage } from '../media/storage.ts';
import type { CourierProvider, CourierTrackingStatus } from './courier.ts';
import { canTransition, type FulfillmentStatus } from './fulfillment.ts';
import { appendOrderEvent, applyFulfillmentTransitionInTx } from './fulfillment-service.ts';
import { orderLookupUrl } from './order-link.ts';
import { orders, shipments, type OrderRow, type ShipmentRow } from './schema.ts';

/**
 * Shipments: the operational record of one courier AWB per order, created by
 * the admin "generate AWB" action through the `CourierProvider` seam.
 *
 * Idempotency: the whole action runs inside one transaction that holds the
 * ORDER row lock, so a double-click serializes — the second attempt finds the
 * existing shipment and returns it (`created: false`); the unique index on
 * `shipments.order_id` backstops whatever slips past. The shipping email is
 * sent AFTER commit with an idempotency key derived from the AWB, so repeats
 * collapse in the email log.
 *
 * Refund rule (NEXT-8, tested in shipment.spec.ts):
 * - refund BEFORE an AWB exists → fulfillment `cancelled`;
 * - refund AFTER one exists → fulfillment `returned`; a still-`registered`
 *   AWB (courier has not picked the parcel up) is additionally cancelled with
 *   the courier — best effort, after commit — and the shipment row goes to
 *   `cancelled`, otherwise to `returned`. Either way the cron stops polling.
 */

export interface ShipmentDeps {
	db: Db;
	courier: CourierProvider;
}

export interface CreateShipmentDeps extends ShipmentDeps {
	email: EmailSender;
	siteName: string;
	/** Canonical origin (PUBLIC_SITE_URL) for the email's order link. */
	publicBaseUrl?: string;
}

export type CreateShipmentError =
	| 'order-not-found'
	/** Only paid orders ship. */
	| 'order-not-paid'
	/** Fulfillment already past packing (shipped/delivered/returned/cancelled). */
	| 'order-not-shippable'
	/** The courier API refused or failed; detail carries the message. */
	| 'courier';

export interface CreatedShipmentRecord {
	shipment: ShipmentRow;
	/** False when the shipment already existed (idempotent re-request). */
	created: boolean;
}

/** Fulfillment states an AWB may be generated from. */
const SHIPPABLE_STATES: FulfillmentStatus[] = ['unfulfilled', 'packed'];

export function getShipmentForOrder(
	deps: Pick<ShipmentDeps, 'db'>,
	orderId: string
): Promise<ShipmentRow | undefined> {
	return deps.db
		.select()
		.from(shipments)
		.where(eq(shipments.orderId, orderId))
		.then((rows) => rows[0]);
}

/**
 * Register the order's AWB with the courier and move fulfillment to `shipped`
 * through the state machine (stepping through `packed` when the operator
 * skipped the explicit packing click — both transitions are recorded). The
 * shipping notification goes out after commit, once per AWB, and its failure
 * never rolls anything back: a retry click re-attempts the (idempotent) send.
 */
export async function createShipmentForOrder(
	deps: CreateShipmentDeps,
	orderId: string,
	actor: string
): Promise<Result<CreatedShipmentRecord, CreateShipmentError>> {
	const result = await deps.db.transaction(
		async (
			tx
		): Promise<Result<{ record: CreatedShipmentRecord; order: OrderRow }, CreateShipmentError>> => {
			// The order lock serializes concurrent clicks: the loser re-reads and
			// finds the winner's shipment.
			const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
			if (!order) return { ok: false, error: 'order-not-found' };

			const [existing] = await tx.select().from(shipments).where(eq(shipments.orderId, orderId));
			if (existing)
				return { ok: true, value: { record: { shipment: existing, created: false }, order } };

			if (order.status !== 'paid')
				return { ok: false, error: 'order-not-paid', detail: order.status };
			if (!SHIPPABLE_STATES.includes(order.fulfillmentStatus)) {
				return { ok: false, error: 'order-not-shippable', detail: order.fulfillmentStatus };
			}

			// The courier call sits inside the lock on purpose: it is bounded by
			// the adapter's timeout, and holding the lock is what makes a racing
			// second click provably unable to register a second AWB.
			let awb: string, trackingUrl: string;
			try {
				({ awb, trackingUrl } = await deps.courier.createShipment({
					orderId: order.id,
					reference: order.id,
					recipient: {
						name: order.shippingAddress?.name || order.email,
						email: order.email,
						address: order.shippingAddress ?? {}
					}
				}));
			} catch (err) {
				return {
					ok: false,
					error: 'courier',
					detail: err instanceof Error ? err.message : String(err)
				};
			}

			const [shipment] = await tx
				.insert(shipments)
				.values({
					id: crypto.randomUUID(),
					orderId: order.id,
					provider: deps.courier.name,
					awb,
					trackingUrl
				})
				.returning();
			await appendOrderEvent(tx, { orderId: order.id, kind: 'awb-generated', actor, note: awb });

			// unfulfilled → packed → shipped: generating the AWB implies packing.
			let current = order;
			if (current.fulfillmentStatus === 'unfulfilled') {
				const packed = await applyFulfillmentTransitionInTx(tx, current, 'packed', {
					actor,
					note: awb
				});
				if (!packed.ok) throw new Error(`unreachable: unfulfilled → packed refused`);
				current = packed.order;
			}
			const shipped = await applyFulfillmentTransitionInTx(tx, current, 'shipped', {
				actor,
				note: awb
			});
			if (!shipped.ok) throw new Error(`unreachable: packed → shipped refused`);

			return { ok: true, value: { record: { shipment, created: true }, order: shipped.order } };
		}
	);
	if (!result.ok) return result;

	// AFTER commit, keyed on the AWB: exactly one notification per shipment,
	// however often the action runs; a previously failed send is retried.
	const { record, order } = result.value;
	if (order.email) {
		const outcome = await deps.email.send({
			to: order.email,
			template: 'shipping-notification',
			data: {
				siteName: deps.siteName,
				orderId: order.id,
				awb: record.shipment.awb,
				trackingUrl: record.shipment.trackingUrl,
				shippingName: order.shippingName || undefined,
				orderUrl:
					deps.publicBaseUrl && order.stripeSessionId
						? orderLookupUrl(deps.publicBaseUrl, order.stripeSessionId)
						: undefined
			},
			idempotencyKey: `shipping-notification:${record.shipment.awb}`
		});
		if (outcome.status === 'error') {
			console.error(`Shipping notification for order ${order.id} failed: ${outcome.error}`);
		}
	}
	return { ok: true, value: record };
}

/** S3 prefix for stored AWB labels — private, like `invoices/`. */
export const SHIPMENT_LABEL_PREFIX = 'shipping-labels/';

export function shipmentLabelKey(shipmentId: string): string {
	return `${SHIPMENT_LABEL_PREFIX}${shipmentId}.pdf`;
}

/**
 * The label PDF bytes, fetched from the courier on first request and stored
 * write-once in the private bucket prefix (the invoice-documents pattern) so
 * later downloads survive courier-side label expiry.
 */
export async function ensureShipmentLabel(
	deps: Pick<ShipmentDeps, 'courier'> & {
		storage: Pick<Storage, 'putObject' | 'statObject' | 'getObjectBytes'>;
	},
	shipment: Pick<ShipmentRow, 'id' | 'awb'>
): Promise<Uint8Array | null> {
	const key = shipmentLabelKey(shipment.id);
	const existing = await deps.storage.statObject(key);
	if (existing) return deps.storage.getObjectBytes(key);
	const bytes = await deps.courier.getLabel(shipment.awb);
	if (!bytes) return null;
	await deps.storage.putObject(key, bytes, 'application/pdf');
	return bytes;
}

/** Actor recorded on order events written by the cron sync. */
export const SHIPMENT_SYNC_ACTOR = 'shipment-sync';
/** Per-run bound: serverless invocations must finish inside their time limit. */
export const SHIPMENT_SYNC_BATCH = 25;

/** Courier states that still need polling. */
const IN_FLIGHT: ShipmentRow['status'][] = ['registered', 'in-transit'];

/** Courier terminal states mapped onto the fulfillment machine. */
const FULFILLMENT_BY_COURIER_STATUS: Partial<Record<CourierTrackingStatus, FulfillmentStatus>> = {
	delivered: 'delivered',
	returned: 'returned'
};

export interface ShipmentSyncResult {
	/** In-flight shipments polled this run (≤ the batch bound). */
	polled: number;
	/** How many changed status. */
	updated: number;
	/** Courier lookups that failed; those rows retry on a later run. */
	errors: number;
}

/**
 * Poll the courier for every in-flight AWB, oldest-synced first, bounded per
 * invocation. Safe to run twice: an unchanged status only bumps
 * `last_synced_at` (no event, no transition), and with the mock provider and
 * nothing in flight the run is a pure no-op. Status changes update the
 * shipment, append a `shipment-status` order event and move fulfillment
 * (`delivered`/`returned`) when that transition is legal — an order already
 * `returned` by the refund rule just keeps its shipment record in sync.
 */
export async function syncShipmentStatuses(
	deps: ShipmentDeps,
	options: { limit?: number } = {}
): Promise<ShipmentSyncResult> {
	const limit = options.limit ?? SHIPMENT_SYNC_BATCH;
	const inFlight = await deps.db
		.select()
		.from(shipments)
		.where(inArray(shipments.status, IN_FLIGHT))
		.orderBy(sql`${shipments.lastSyncedAt} asc nulls first`)
		.limit(limit);

	const result: ShipmentSyncResult = { polled: 0, updated: 0, errors: 0 };
	for (const shipment of inFlight) {
		result.polled += 1;
		let status: CourierTrackingStatus | null;
		try {
			status = await deps.courier.trackShipment(shipment.awb);
		} catch (err) {
			result.errors += 1;
			console.error(`Shipment sync: tracking ${shipment.awb} failed:`, err);
			continue;
		}

		const now = new Date();
		if (!status || status === shipment.status) {
			// No news — just rotate the row to the back of the polling order.
			await deps.db
				.update(shipments)
				.set({ lastSyncedAt: now })
				.where(eq(shipments.id, shipment.id));
			continue;
		}

		await deps.db.transaction(async (tx) => {
			const [order] = await tx
				.select()
				.from(orders)
				.where(eq(orders.id, shipment.orderId))
				.for('update');
			await tx
				.update(shipments)
				.set({ status, lastSyncedAt: now, updatedAt: now })
				.where(eq(shipments.id, shipment.id));
			await appendOrderEvent(tx, {
				orderId: shipment.orderId,
				kind: 'shipment-status',
				actor: SHIPMENT_SYNC_ACTOR,
				note: `${shipment.awb}: ${status}`
			});
			const target = FULFILLMENT_BY_COURIER_STATUS[status];
			if (order && target && canTransition(order.fulfillmentStatus, target)) {
				await applyFulfillmentTransitionInTx(tx, order, target, {
					actor: SHIPMENT_SYNC_ACTOR,
					note: shipment.awb
				});
			}
		});
		result.updated += 1;
	}
	return result;
}

export interface RefundShipmentPlan {
	/** AWB to cancel with the courier after commit; null when none applies. */
	cancelAwb: string | null;
}

/**
 * The refund side of the rule (see the module comment), inside the refund
 * webhook's ledger transaction. Only decides and records — the courier
 * cancellation itself happens after commit via `cancelShipmentBestEffort`.
 */
export async function applyRefundShipmentInTx(
	tx: DbTx,
	order: OrderRow,
	actor: string
): Promise<RefundShipmentPlan> {
	const [shipment] = await tx
		.select()
		.from(shipments)
		.where(eq(shipments.orderId, order.id))
		.for('update');

	if (!shipment) {
		// Nothing left the warehouse: the order will never be fulfilled.
		if (canTransition(order.fulfillmentStatus, 'cancelled')) {
			await applyFulfillmentTransitionInTx(tx, order, 'cancelled', { actor, note: 'refund' });
		}
		return { cancelAwb: null };
	}

	let cancelAwb: string | null = null;
	const now = new Date();
	if (shipment.status === 'registered') {
		// Courier has not picked the parcel up — the AWB itself gets cancelled.
		await tx
			.update(shipments)
			.set({ status: 'cancelled', updatedAt: now })
			.where(eq(shipments.id, shipment.id));
		cancelAwb = shipment.awb;
	} else if (shipment.status === 'in-transit' || shipment.status === 'delivered') {
		// Goods are (or were) with the customer: they come back as a return.
		await tx
			.update(shipments)
			.set({ status: 'returned', updatedAt: now })
			.where(eq(shipments.id, shipment.id));
	}
	if (canTransition(order.fulfillmentStatus, 'returned')) {
		await applyFulfillmentTransitionInTx(tx, order, 'returned', { actor, note: 'refund' });
	}
	return { cancelAwb };
}

/**
 * Cancel an AWB with the courier — after the refund committed, so a courier
 * API failure can never roll back the refund bookkeeping. Both outcomes land
 * on the order's trail; a failure is the operator's cue to cancel manually.
 */
export async function cancelShipmentBestEffort(
	deps: ShipmentDeps,
	orderId: string,
	awb: string,
	actor: string
): Promise<void> {
	try {
		await deps.courier.cancelShipment(awb);
		await appendOrderEvent(deps.db, { orderId, kind: 'shipment-cancelled', actor, note: awb });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Courier cancellation of ${awb} failed: ${message}`);
		await appendOrderEvent(deps.db, {
			orderId,
			kind: 'shipment-cancel-failed',
			actor,
			note: `${awb}: ${message}`
		});
	}
}
