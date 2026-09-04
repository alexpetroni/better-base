import { desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import type { DbTx } from '../../server/event-ledger/core.ts';
import { canTransition, type FulfillmentStatus } from './fulfillment.ts';
import { orderEvents, orders, type OrderEventRow, type OrderRow } from './schema.ts';

/**
 * THE single writer of `orders.fulfillment_status`. Every change goes through
 * `transitionFulfillment`, which validates the move against the state machine
 * and appends the matching `order_events` row in the same transaction — the
 * status and its history cannot drift apart, and an illegal move is a typed
 * rejection, never a silent no-op.
 */

export type TransitionActor = {
	/** Staff email for admin actions; a system name (e.g. `stripe-webhook`) otherwise. */
	actor: string;
	note?: string;
};

export type TransitionResult =
	| { ok: true; order: OrderRow; event: OrderEventRow }
	| { ok: false; error: 'not-found' }
	| { ok: false; error: 'illegal-transition'; from: FulfillmentStatus; to: FulfillmentStatus };

/**
 * Apply one validated transition inside the CALLER's transaction. The caller
 * must already hold the order's row lock (`FOR UPDATE`) and pass the locked
 * row — this is the shared core of `transitionFulfillment` and the shipment
 * service (AWB generation and the refund rule move the same column).
 */
export async function applyFulfillmentTransitionInTx(
	tx: DbTx,
	order: Pick<OrderRow, 'id' | 'fulfillmentStatus'>,
	to: FulfillmentStatus,
	by: TransitionActor
): Promise<TransitionResult> {
	const from = order.fulfillmentStatus;
	if (!canTransition(from, to, by.actor))
		return { ok: false, error: 'illegal-transition', from, to };

	const [updated] = await tx
		.update(orders)
		.set({ fulfillmentStatus: to })
		.where(eq(orders.id, order.id))
		.returning();
	const event = await appendOrderEvent(tx, {
		orderId: order.id,
		kind: 'fulfillment-transition',
		actor: by.actor,
		fromStatus: from,
		toStatus: to,
		note: by.note
	});
	return { ok: true, order: updated, event };
}

export async function transitionFulfillment(
	deps: { db: Db },
	orderId: string,
	to: FulfillmentStatus,
	by: TransitionActor
): Promise<TransitionResult> {
	return deps.db.transaction(async (tx): Promise<TransitionResult> => {
		// Lock the row so two concurrent transitions serialize: the second one
		// revalidates against the state the first one committed.
		const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
		if (!order) return { ok: false, error: 'not-found' };
		return applyFulfillmentTransitionInTx(tx, order, to, by);
	});
}

/**
 * Append one history row. Takes the caller's transaction so the event commits
 * (or rolls back) with the change it describes.
 */
export async function appendOrderEvent(
	executor: Db | DbTx,
	entry: {
		orderId: string;
		kind: string;
		actor: string;
		fromStatus?: FulfillmentStatus;
		toStatus?: FulfillmentStatus;
		note?: string;
	}
): Promise<OrderEventRow> {
	const [row] = await executor
		.insert(orderEvents)
		.values({
			id: crypto.randomUUID(),
			orderId: entry.orderId,
			kind: entry.kind,
			actor: entry.actor,
			fromStatus: entry.fromStatus ?? null,
			toStatus: entry.toStatus ?? null,
			note: entry.note ?? ''
		})
		.returning();
	return row;
}

/** Newest-first history for the admin order detail. */
export function listOrderEvents(deps: { db: Db }, orderId: string): Promise<OrderEventRow[]> {
	return deps.db
		.select()
		.from(orderEvents)
		.where(eq(orderEvents.orderId, orderId))
		.orderBy(desc(orderEvents.createdAt), desc(orderEvents.id));
}
