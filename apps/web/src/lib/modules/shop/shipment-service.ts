import { and, desc, eq, gt, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import type { DbTx } from '../../server/event-ledger/core.ts';
import type { Result } from '../../util/result.ts';
import type { EmailSender } from '../email/service.ts';
import type { Storage } from '../media/storage.ts';
import {
	isCourierAuthError,
	type CourierProvider,
	type CourierTrackingStatus,
	type CreatedShipment
} from './courier.ts';
import { canTransition, SHIPMENT_SYNC_ACTOR, type FulfillmentStatus } from './fulfillment.ts';
import { appendOrderEvent, applyFulfillmentTransitionInTx } from './fulfillment-service.ts';
import { orderLookupUrl } from './order-link.ts';
import {
	orders,
	shipments,
	type OrderRow,
	type ShipmentRow,
	type ShipmentStatus,
	type ShippingAddress
} from './schema.ts';

/**
 * Shipments: the operational record of an order's courier AWB, created by the
 * admin "generate AWB" action through the `CourierProvider` seam.
 *
 * Creation is TWO-PHASE (FIX-11, audit P2 "courier call inside the
 * transaction can orphan an AWB"):
 * 1. CLAIM — under the order row lock: validate (paid, shippable, recipient
 *    data complete), insert a `creating` row, commit. A racing second click
 *    finds the claim and returns it (`created: false`); the partial unique
 *    index on live rows backstops whatever slips past.
 * 2. COURIER — outside any lock, bounded by the adapter timeout. The claim is
 *    already committed, so a process dying here leaves a row whose
 *    `clientInternalReference` (= order id) finds the AWB in the courier's
 *    portal; a claim older than `SHIPMENT_CREATING_STALE_MS` is failed and
 *    replaced by the next click.
 * 3. RECORD — under the order lock again: `registered` (awb, tracking) plus
 *    the fulfillment walk to `shipped`; on a courier failure `failed` with
 *    the courier's reason (a retry inserts a fresh claim). If the order
 *    stopped being shippable meanwhile (a refund landed mid-call), the fresh
 *    AWB is cancelled with the courier.
 * The shipping email goes out AFTER commit, keyed on the AWB, so repeats
 * collapse in the email log.
 *
 * Refund rule (NEXT-8, tested in shipment.spec.ts):
 * - refund BEFORE a usable AWB exists → fulfillment `cancelled`;
 * - refund AFTER one exists → fulfillment `returned`; a still-`registered`
 *   AWB (courier has not picked the parcel up) is additionally cancelled with
 *   the courier — best effort, after commit — and the shipment row goes to
 *   `cancelled`, otherwise to `returned`. Either way the cron stops polling.
 */

export { SHIPMENT_SYNC_ACTOR };

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
	/**
	 * The stored address lacks what the courier requires; detail lists the
	 * missing `RecipientField`s comma-separated. Raised BEFORE any courier call.
	 */
	| 'missing-recipient-data'
	/** The courier API refused or failed; detail carries the message. */
	| 'courier';

/**
 * Recipient fields no AWB can be registered without (Sameday validates all
 * four; `county` is the address `state` as Stripe collects it).
 */
export const REQUIRED_RECIPIENT_FIELDS = ['phone', 'county', 'city', 'line1'] as const;
export type RecipientField = (typeof REQUIRED_RECIPIENT_FIELDS)[number];

/** Which required recipient fields the stored address lacks. Pure. */
export function missingRecipientFields(
	address: ShippingAddress | null | undefined
): RecipientField[] {
	const present = (value: string | undefined) => !!value && value.trim().length > 0;
	const missing: RecipientField[] = [];
	if (!present(address?.phone)) missing.push('phone');
	if (!present(address?.state)) missing.push('county');
	if (!present(address?.city)) missing.push('city');
	if (!present(address?.line1)) missing.push('line1');
	return missing;
}

export type UpdateShippingAddressError = 'order-not-found' | 'missing-recipient-data';

const ADDRESS_FIELD_MAX = 120;
const ADDRESS_PHONE_MAX = 40;
const ADDRESS_POSTAL_MAX = 20;
const ADDRESS_KEYS: ReadonlyArray<keyof ShippingAddress> = [
	'name',
	'phone',
	'line1',
	'line2',
	'city',
	'state',
	'postalCode',
	'country'
];

/**
 * Operator-typed recipient data (FIX-11): the way out of
 * `missing-recipient-data` for orders placed before Checkout collected a
 * phone, or whose Stripe address lacks a county. Every field is trimmed and
 * bounded, the courier's four are required, and the trail records WHICH
 * fields changed — never their values (order_events are retained after
 * GDPR erasure nulls the address).
 */
export async function updateOrderShippingAddress(
	deps: Pick<ShipmentDeps, 'db'>,
	orderId: string,
	input: Partial<Record<keyof ShippingAddress, string>>,
	actor: string
): Promise<Result<ShippingAddress, UpdateShippingAddressError>> {
	const clean = (value: string | undefined, max: number) => (value ?? '').trim().slice(0, max);
	const address: ShippingAddress = {};
	const put = (key: keyof ShippingAddress, value: string) => {
		if (value) address[key] = value;
	};
	put('name', clean(input.name, ADDRESS_FIELD_MAX));
	put('phone', clean(input.phone, ADDRESS_PHONE_MAX));
	put('line1', clean(input.line1, ADDRESS_FIELD_MAX));
	put('line2', clean(input.line2, ADDRESS_FIELD_MAX));
	put('city', clean(input.city, ADDRESS_FIELD_MAX));
	put('state', clean(input.state, ADDRESS_FIELD_MAX));
	put('postalCode', clean(input.postalCode, ADDRESS_POSTAL_MAX));
	address.country = clean(input.country, 2).toUpperCase() || 'RO';

	const missing = missingRecipientFields(address);
	if (missing.length > 0) {
		return { ok: false, error: 'missing-recipient-data', detail: missing.join(', ') };
	}

	return deps.db.transaction(
		async (tx): Promise<Result<ShippingAddress, UpdateShippingAddressError>> => {
			const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
			if (!order) return { ok: false, error: 'order-not-found' };
			const before = order.shippingAddress ?? {};
			const changed = ADDRESS_KEYS.filter((key) => (before[key] ?? '') !== (address[key] ?? ''));
			if (changed.length > 0) {
				await tx.update(orders).set({ shippingAddress: address }).where(eq(orders.id, orderId));
				await appendOrderEvent(tx, {
					orderId,
					kind: 'shipping-address-updated',
					actor,
					note: changed.join(', ')
				});
			}
			return { ok: true, value: address };
		}
	);
}

export interface CreatedShipmentRecord {
	shipment: ShipmentRow;
	/** False when a live shipment already existed (idempotent re-request). */
	created: boolean;
}

/** Fulfillment states an AWB may be generated from. */
const SHIPPABLE_STATES: FulfillmentStatus[] = ['unfulfilled', 'packed'];

/** Rows that no longer hold an AWB for the order: a new one may be generated. */
export const SHIPMENT_REPLACEABLE_STATUSES: ShipmentStatus[] = ['cancelled', 'failed'];

/** A `creating` claim older than this with no outcome means the process died mid-call. */
export const SHIPMENT_CREATING_STALE_MS = 5 * 60_000;
const STALE_CLAIM_DETAIL =
	'no courier answer recorded for this claim (the process ended mid-call) — ' +
	'check the courier portal for the order id before trusting the retry';

/** Error texts are stored on rows and trails: bounded. */
const ERROR_TEXT_MAX = 500;
function errorText(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.length > ERROR_TEXT_MAX ? `${message.slice(0, ERROR_TEXT_MAX)}…` : message;
}

/**
 * The shipment the order page shows: the live row when there is one, else
 * the most recent replaced row (a cancelled or failed AWB is still history).
 */
export function getShipmentForOrder(
	deps: Pick<ShipmentDeps, 'db'>,
	orderId: string
): Promise<ShipmentRow | undefined> {
	return deps.db
		.select()
		.from(shipments)
		.where(eq(shipments.orderId, orderId))
		.orderBy(
			sql`case when ${inArray(shipments.status, SHIPMENT_REPLACEABLE_STATUSES)} then 1 else 0 end`,
			desc(shipments.createdAt)
		)
		.limit(1)
		.then((rows) => rows[0]);
}

/** The order's live shipment row, locked in the caller's transaction. */
async function lockActiveShipment(tx: DbTx, orderId: string): Promise<ShipmentRow | undefined> {
	const [row] = await tx
		.select()
		.from(shipments)
		.where(
			and(
				eq(shipments.orderId, orderId),
				notInArray(shipments.status, SHIPMENT_REPLACEABLE_STATUSES)
			)
		)
		.for('update');
	return row;
}

type Claim =
	| { kind: 'existing'; shipment: ShipmentRow; order: OrderRow }
	| { kind: 'claimed'; shipment: ShipmentRow; order: OrderRow };

/**
 * Register the order's AWB with the courier and move fulfillment to `shipped`
 * through the state machine (stepping through `packed` when the operator
 * skipped the explicit packing click — both transitions are recorded). See the
 * module comment for the three phases. `options.now` is a test seam for the
 * stale-claim rule.
 */
export async function createShipmentForOrder(
	deps: CreateShipmentDeps,
	orderId: string,
	actor: string,
	options: { now?: Date } = {}
): Promise<Result<CreatedShipmentRecord, CreateShipmentError>> {
	const now = options.now ?? new Date();

	// Phase 1 — claim under the order lock; committed before any courier call.
	const claim = await deps.db.transaction(
		async (tx): Promise<Result<Claim, CreateShipmentError>> => {
			const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
			if (!order) return { ok: false, error: 'order-not-found' };

			const active = await lockActiveShipment(tx, orderId);
			if (active) {
				const stale =
					active.status === 'creating' &&
					active.createdAt.getTime() <= now.getTime() - SHIPMENT_CREATING_STALE_MS;
				if (!stale) return { ok: true, value: { kind: 'existing', shipment: active, order } };
				await tx
					.update(shipments)
					.set({ status: 'failed', lastError: STALE_CLAIM_DETAIL, updatedAt: now })
					.where(eq(shipments.id, active.id));
				await appendOrderEvent(tx, {
					orderId: order.id,
					kind: 'awb-failed',
					actor,
					note: STALE_CLAIM_DETAIL
				});
			}

			if (order.status !== 'paid')
				return { ok: false, error: 'order-not-paid', detail: order.status };
			if (!SHIPPABLE_STATES.includes(order.fulfillmentStatus)) {
				return { ok: false, error: 'order-not-shippable', detail: order.fulfillmentStatus };
			}
			// Refused HERE, before the courier: Sameday rejects an AWB without a
			// phone or county, and its refusal used to be the only signal. The
			// operator gets the missing fields and an address editor instead.
			const missing = missingRecipientFields(order.shippingAddress);
			if (missing.length > 0) {
				return { ok: false, error: 'missing-recipient-data', detail: missing.join(', ') };
			}

			const [shipment] = await tx
				.insert(shipments)
				.values({
					id: crypto.randomUUID(),
					orderId: order.id,
					provider: deps.courier.name,
					status: 'creating',
					awb: null,
					createdAt: now,
					updatedAt: now
				})
				.returning();
			return { ok: true, value: { kind: 'claimed', shipment, order } };
		}
	);
	if (!claim.ok) return claim;
	if (claim.value.kind === 'existing') {
		// A previously failed send is retried; a claim without an AWB has
		// nothing to mail yet.
		await sendShippingNotification(deps, claim.value.order, claim.value.shipment);
		return { ok: true, value: { shipment: claim.value.shipment, created: false } };
	}
	const { shipment: claimed, order } = claim.value;

	// Phase 2 — the courier, outside any row lock.
	let created: CreatedShipment;
	try {
		created = await deps.courier.createShipment({
			orderId: order.id,
			reference: order.id,
			recipient: {
				name: order.shippingAddress?.name || order.email,
				email: order.email,
				phone: order.shippingAddress?.phone,
				address: order.shippingAddress ?? {}
			}
		});
	} catch (err) {
		const detail = errorText(err);
		await deps.db.transaction(async (tx) => {
			await tx
				.update(shipments)
				.set({ status: 'failed', lastError: detail, updatedAt: new Date() })
				.where(eq(shipments.id, claimed.id));
			await appendOrderEvent(tx, { orderId: order.id, kind: 'awb-failed', actor, note: detail });
		});
		return { ok: false, error: 'courier', detail };
	}

	// Phase 3 — record the AWB and walk fulfillment, under the order lock.
	const recorded = await deps.db.transaction(async (tx) => {
		const [current] = await tx.select().from(orders).where(eq(orders.id, order.id)).for('update');
		const [shipment] = await tx
			.update(shipments)
			.set({
				status: 'registered',
				awb: created.awb,
				trackingUrl: created.trackingUrl,
				updatedAt: new Date()
			})
			.where(eq(shipments.id, claimed.id))
			.returning();
		await appendOrderEvent(tx, {
			orderId: order.id,
			kind: 'awb-generated',
			actor,
			note: created.awb
		});

		const shippable =
			!!current &&
			current.status === 'paid' &&
			SHIPPABLE_STATES.includes(current.fulfillmentStatus);
		if (!shippable) return { shipment, order: current ?? order, shippable: false as const };

		// unfulfilled → packed → shipped: generating the AWB implies packing.
		let walked = current;
		if (walked.fulfillmentStatus === 'unfulfilled') {
			const packed = await applyFulfillmentTransitionInTx(tx, walked, 'packed', {
				actor,
				note: created.awb
			});
			if (!packed.ok) throw new Error(`unreachable: unfulfilled → packed refused`);
			walked = packed.order;
		}
		const shipped = await applyFulfillmentTransitionInTx(tx, walked, 'shipped', {
			actor,
			note: created.awb
		});
		if (!shipped.ok) throw new Error(`unreachable: packed → shipped refused`);
		return { shipment, order: shipped.order, shippable: true as const };
	});

	if (!recorded.shippable) {
		// The order stopped being shippable while the courier was registering
		// (a refund landed mid-call): the AWB exists, so take it back.
		const outcome = await cancelShipmentBestEffort(deps, order.id, created.awb, actor, {
			shipmentId: recorded.shipment.id
		});
		return {
			ok: false,
			error: 'order-not-shippable',
			detail:
				`${recorded.order.fulfillmentStatus}; AWB ${created.awb} ` +
				(outcome === 'cancelled'
					? 'was cancelled with the courier'
					: 'could NOT be cancelled — handle it in the courier portal')
		};
	}

	await sendShippingNotification(deps, recorded.order, recorded.shipment);
	return { ok: true, value: { shipment: recorded.shipment, created: true } };
}

/**
 * AFTER commit, keyed on the AWB: exactly one notification per shipment,
 * however often the action runs; a failure never rolls anything back and a
 * previously failed send is retried by the next click.
 */
async function sendShippingNotification(
	deps: CreateShipmentDeps,
	order: OrderRow,
	shipment: ShipmentRow
): Promise<void> {
	if (!order.email || !shipment.awb) return;
	const outcome = await deps.email.send({
		to: order.email,
		template: 'shipping-notification',
		data: {
			siteName: deps.siteName,
			orderId: order.id,
			awb: shipment.awb,
			trackingUrl: shipment.trackingUrl,
			shippingName: order.shippingName || undefined,
			orderUrl:
				deps.publicBaseUrl && order.stripeSessionId
					? orderLookupUrl(deps.publicBaseUrl, order.stripeSessionId)
					: undefined
		},
		idempotencyKey: `shipping-notification:${shipment.awb}`
	});
	if (outcome.status === 'error') {
		console.error(`Shipping notification for order ${order.id} failed: ${outcome.error}`);
	}
}

/** S3 prefix for stored AWB labels — private, like `invoices/`. */
export const SHIPMENT_LABEL_PREFIX = 'shipping-labels/';

export function shipmentLabelKey(shipmentId: string): string {
	return `${SHIPMENT_LABEL_PREFIX}${shipmentId}.pdf`;
}

/**
 * The label PDF bytes, fetched from the courier on first request and stored
 * write-once in the private bucket prefix (the invoice-documents pattern) so
 * later downloads survive courier-side label expiry. Null without an AWB.
 */
export async function ensureShipmentLabel(
	deps: Pick<ShipmentDeps, 'courier'> & {
		storage: Pick<Storage, 'putObject' | 'statObject' | 'getObjectBytes'>;
	},
	shipment: Pick<ShipmentRow, 'id' | 'awb'>
): Promise<Uint8Array | null> {
	if (!shipment.awb) return null;
	const key = shipmentLabelKey(shipment.id);
	const existing = await deps.storage.statObject(key);
	if (existing) return deps.storage.getObjectBytes(key);
	const bytes = await deps.courier.getLabel(shipment.awb);
	if (!bytes) return null;
	await deps.storage.putObject(key, bytes, 'application/pdf');
	return bytes;
}

/** Per-run bound: serverless invocations must finish inside their time limit. */
export const SHIPMENT_SYNC_BATCH = 25;
/** First retry delay after a tracking failure; doubles per consecutive failure. */
export const SHIPMENT_SYNC_BACKOFF_BASE_MS = 15 * 60_000;
/** Backoff ceiling: a poisoned AWB is still retried daily. */
export const SHIPMENT_SYNC_BACKOFF_MAX_MS = 24 * 60 * 60_000;

/** Delay before the next poll after `errorCount` consecutive failures. Pure. */
export function syncBackoffMs(errorCount: number): number {
	return Math.min(
		SHIPMENT_SYNC_BACKOFF_BASE_MS * 2 ** Math.max(0, errorCount - 1),
		SHIPMENT_SYNC_BACKOFF_MAX_MS
	);
}

/** Courier states that still need polling. */
const IN_FLIGHT: ShipmentStatus[] = ['registered', 'in-transit'];

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
	/** Courier lookups that failed; those rows retry with backoff. */
	errors: number;
	/**
	 * Set when the run stopped early: `auth` = the courier rejected the
	 * credentials, so no AWB is at fault and nothing further was polled.
	 */
	aborted?: 'auth';
}

/**
 * Poll the courier for every DUE in-flight AWB, oldest-synced first, bounded
 * per invocation. Safe to run twice: an unchanged status only bumps
 * `last_synced_at` (no event, no transition), and with the mock provider and
 * nothing in flight the run is a pure no-op. Status changes update the
 * shipment, append a `shipment-status` order event and move fulfillment
 * (`delivered`/`returned`) when that transition is legal — an order already
 * `returned` by the refund rule just keeps its shipment record in sync.
 *
 * Health (FIX-11, audit P1 "shipment-sync starvation"): a throwing lookup
 * rotates the row (`last_synced_at`), backs it off (`next_sync_at`,
 * `error_count`, `last_error`) and writes a `shipment-sync-error` event, so
 * a few poisoned AWBs cannot starve the batch; a courier `cancelled`
 * (outside the refund path) hands the order back to `packed`; a
 * `CourierAuthError` aborts the run at error level — the credentials, not a
 * row, are broken — after flagging the row it hit so the dashboard shows it.
 */
export async function syncShipmentStatuses(
	deps: ShipmentDeps,
	options: { limit?: number; now?: Date } = {}
): Promise<ShipmentSyncResult> {
	const limit = options.limit ?? SHIPMENT_SYNC_BATCH;
	const now = options.now ?? new Date();
	const due = await deps.db
		.select()
		.from(shipments)
		.where(
			and(
				inArray(shipments.status, IN_FLIGHT),
				or(isNull(shipments.nextSyncAt), lte(shipments.nextSyncAt, now))
			)
		)
		.orderBy(sql`${shipments.lastSyncedAt} asc nulls first`)
		.limit(limit);

	const result: ShipmentSyncResult = { polled: 0, updated: 0, errors: 0 };
	const healthy = { lastSyncedAt: now, nextSyncAt: null, errorCount: 0, lastError: null };
	for (const shipment of due) {
		if (!shipment.awb) continue;
		result.polled += 1;
		let status: CourierTrackingStatus | null;
		try {
			status = await deps.courier.trackShipment(shipment.awb);
		} catch (err) {
			result.errors += 1;
			const message = errorText(err);
			const auth = isCourierAuthError(err);
			const errorCount = shipment.errorCount + 1;
			await deps.db.transaction(async (tx) => {
				await tx
					.update(shipments)
					.set({
						lastSyncedAt: now,
						errorCount,
						lastError: message,
						// The credentials are at fault, not this AWB: no backoff.
						nextSyncAt: auth ? null : new Date(now.getTime() + syncBackoffMs(errorCount)),
						updatedAt: now
					})
					.where(eq(shipments.id, shipment.id));
				await appendOrderEvent(tx, {
					orderId: shipment.orderId,
					kind: 'shipment-sync-error',
					actor: SHIPMENT_SYNC_ACTOR,
					note: `${shipment.awb}: ${message}`
				});
			});
			if (auth) {
				console.error(`Shipment sync aborted: the courier rejected the credentials — ${message}`);
				result.aborted = 'auth';
				break;
			}
			console.error(`Shipment sync: tracking ${shipment.awb} failed: ${message}`);
			continue;
		}

		if (!status || status === shipment.status) {
			// No news — rotate the row to the back of the polling order, healed.
			await deps.db.update(shipments).set(healthy).where(eq(shipments.id, shipment.id));
			continue;
		}

		if (status === 'cancelled') {
			await applyExternalCancellation(deps, shipment, now);
			result.updated += 1;
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
				.set({ status, ...healthy, updatedAt: now })
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
					note: shipment.awb ?? ''
				});
			}
		});
		result.updated += 1;
	}
	return result;
}

/**
 * The courier cancelled the AWB on its side (audit P1 "courier-cancelled AWB
 * is a dead end"): the parcel is back at the warehouse. The row is closed as
 * `cancelled`, the trail says so, and a `shipped` order steps back to
 * `packed` (the sync-only edge) so a replacement AWB can be generated.
 */
async function applyExternalCancellation(
	deps: Pick<ShipmentDeps, 'db'>,
	shipment: ShipmentRow,
	now: Date
): Promise<void> {
	await deps.db.transaction(async (tx) => {
		const [order] = await tx
			.select()
			.from(orders)
			.where(eq(orders.id, shipment.orderId))
			.for('update');
		await tx
			.update(shipments)
			.set({ status: 'cancelled', lastSyncedAt: now, nextSyncAt: null, updatedAt: now })
			.where(eq(shipments.id, shipment.id));
		await appendOrderEvent(tx, {
			orderId: shipment.orderId,
			kind: 'awb-cancelled-externally',
			actor: SHIPMENT_SYNC_ACTOR,
			note: shipment.awb ?? ''
		});
		if (order && canTransition(order.fulfillmentStatus, 'packed', SHIPMENT_SYNC_ACTOR)) {
			await applyFulfillmentTransitionInTx(tx, order, 'packed', {
				actor: SHIPMENT_SYNC_ACTOR,
				note: shipment.awb ?? ''
			});
		}
	});
}

export interface ShipmentSyncHealth {
	/** In-flight rows whose last poll failed (`error_count > 0`). */
	failing: number;
	/** The most recently recorded failure text, for the dashboard banner. */
	latestError: string | null;
}

/** What the admin dashboard shows while the sync is failing. */
export async function shipmentSyncHealth(
	deps: Pick<ShipmentDeps, 'db'>
): Promise<ShipmentSyncHealth> {
	const failingRows = and(inArray(shipments.status, IN_FLIGHT), gt(shipments.errorCount, 0));
	const [{ failing }] = await deps.db
		.select({ failing: sql<number>`count(*)::int` })
		.from(shipments)
		.where(failingRows);
	if (!failing) return { failing: 0, latestError: null };
	const [latest] = await deps.db
		.select({ lastError: shipments.lastError })
		.from(shipments)
		.where(failingRows)
		.orderBy(desc(shipments.updatedAt))
		.limit(1);
	return { failing, latestError: latest?.lastError ?? null };
}

export interface RefundShipmentPlan {
	/** AWB to cancel with the courier after commit; null when none applies. */
	cancelAwb: string | null;
}

/**
 * The refund side of the rule (see the module comment), inside the refund
 * webhook's ledger transaction. Only decides and records — the courier
 * cancellation itself happens after commit via `cancelShipmentBestEffort`.
 * Acts on the order's LIVE row; a `creating` claim has no AWB yet, so it
 * counts as "nothing left the warehouse" and the claim's own third phase
 * cancels whatever the courier returns.
 */
export async function applyRefundShipmentInTx(
	tx: DbTx,
	order: OrderRow,
	actor: string
): Promise<RefundShipmentPlan> {
	const shipment = await lockActiveShipment(tx, order.id);

	if (!shipment || shipment.status === 'creating') {
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
 * With `shipmentId`, a successful cancellation also closes that row (the
 * refund path closes its row in-transaction and passes none).
 */
export async function cancelShipmentBestEffort(
	deps: ShipmentDeps,
	orderId: string,
	awb: string,
	actor: string,
	options: { shipmentId?: string } = {}
): Promise<'cancelled' | 'failed'> {
	try {
		await deps.courier.cancelShipment(awb);
		if (options.shipmentId) {
			await deps.db
				.update(shipments)
				.set({ status: 'cancelled', updatedAt: new Date() })
				.where(eq(shipments.id, options.shipmentId));
		}
		await appendOrderEvent(deps.db, { orderId, kind: 'shipment-cancelled', actor, note: awb });
		return 'cancelled';
	} catch (err) {
		const message = errorText(err);
		console.error(`Courier cancellation of ${awb} failed: ${message}`);
		await appendOrderEvent(deps.db, {
			orderId,
			kind: 'shipment-cancel-failed',
			actor,
			note: `${awb}: ${message}`
		});
		return 'failed';
	}
}
