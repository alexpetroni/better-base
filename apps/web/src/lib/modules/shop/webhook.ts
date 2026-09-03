import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import Stripe from 'stripe';
import type { Db } from '../../db/client.ts';
import { runOnce, type DbTx } from '../../server/event-ledger/core.ts';
import { processedEvents, type ProcessedEventRow } from '../../server/event-ledger/schema.ts';
import type { EmailAttachment, EmailSender } from '../email/service.ts';
import { issueInvoiceForOrderInTx, issueStornoForOrderInTx } from '$lib/modules/invoice/server';
import { enrollFromOrderEmail } from '$lib/modules/nurture/server';
import { loadSettings } from '$lib/modules/settings/server';
import type { SiteSettings } from '../settings/registry.ts';
import { invoices } from '../invoice/schema.ts';
import {
	parseBuyerCompanyMetadata,
	parseCartMetadata,
	BUYER_COMPANY_METADATA_KEY,
	CART_METADATA_KEY
} from './checkout.ts';
import { appendOrderEvent, applyFulfillmentTransitionInTx } from './fulfillment-service.ts';
import { canTransition, FULFILLMENT_STATUSES, type FulfillmentStatus } from './fulfillment.ts';
import {
	orderItems,
	orders,
	pendingRefunds,
	products,
	type OrderRow,
	type OrderStatus,
	type PendingRefundRow,
	type ShippingAddress
} from './schema.ts';
import { parseShippingMetadata, SHIPPING_METADATA_KEY } from './shipping.ts';
import type { CourierProvider } from './courier.ts';
import { orderLookupUrl } from './order-link.ts';
import { applyRefundShipmentInTx, cancelShipmentBestEffort } from './shipment-service.ts';

/**
 * Stripe webhook processing, split from the route so integration tests can
 * exercise it directly: `verifyStripeEvent` (pure signature crypto via the
 * SDK — no network) and `processStripeEvent` (order creation, stock, email).
 *
 * Idempotency is two-layered:
 * - the `processed_events` ledger claims the provider EVENT id inside the
 *   same transaction as the effect, so a redelivery of any handled type is a
 *   detected no-op (`duplicate-event`);
 * - the unique `stripe_session_id` claim additionally collapses the same
 *   SESSION arriving under different event ids to one order
 *   (`duplicate-session`).
 *
 * Ordering is NOT guaranteed by Stripe, so every handler is written for
 * either arrival order (FIX-10, audit 2026-09-03 P0 #3 + P1 "pending orders"):
 * a refund before its order is remembered in `pending_refunds` and consumed
 * at order creation; an async payment result before its `completed` event
 * creates the order from the session it carries; the two are serialized per
 * payment intent by a transaction-scoped advisory lock.
 */

/** Actor recorded in order_events for changes made by this webhook. */
export const WEBHOOK_ACTOR = 'stripe-webhook';

// Constructed only for its offline `webhooks` helpers — the key is never used.
const webhookCrypto = new Stripe('sk_offline_signature_verification_only');

/** Verify and parse a webhook payload. Throws on a missing/invalid signature. */
export function verifyStripeEvent(
	payload: string,
	signatureHeader: string,
	secret: string
): Promise<Stripe.Event> {
	return webhookCrypto.webhooks.constructEventAsync(payload, signatureHeader, secret);
}

/** The issued invoice's PDF, ready to ride along on the confirmation email. */
export interface InvoiceEmailInfo {
	displayNumber: string;
	attachment: EmailAttachment;
}

export interface WebhookDeps {
	db: Db;
	email: EmailSender;
	siteName: string;
	/**
	 * Loads/renders the order's invoice PDF (modules/invoice supplies the
	 * implementation). Optional, and any failure is swallowed: the
	 * confirmation email must go out even when the document layer is down —
	 * the customer keeps the durable order link, where the invoice renders
	 * lazily once available.
	 */
	invoiceAttachment?: (orderId: string) => Promise<InvoiceEmailInfo | null>;
	/** Canonical origin (PUBLIC_SITE_URL) for durable customer links. */
	publicBaseUrl?: string;
	/**
	 * Courier seam, used on refund to cancel a not-yet-picked-up AWB with the
	 * carrier (best effort, after commit). Optional so callers without a
	 * shipping concern (older tests) keep working; the route always passes it.
	 */
	courier?: CourierProvider;
}

export type WebhookOutcome =
	/** An order row was created; `status` says what it was created AS (paid, pending, refunded, failed). */
	| { kind: 'order-created'; orderId: string; status: OrderStatus }
	/** Same provider event id delivered again — the ledger skipped the effect. */
	| { kind: 'duplicate-event'; eventId: string; firstOutcome: string }
	/** Same checkout session under a NEW event id — the order already exists. */
	| { kind: 'duplicate-session'; sessionId: string }
	| { kind: 'empty-cart'; sessionId: string }
	/** Full refund applied: status refunded, storno, fulfillment/AWB handled. */
	| { kind: 'refund-marked'; orderId: string }
	/** Partial refund recorded on a still-paid order; nothing else moved. */
	| { kind: 'refund-partial'; orderId: string; refundedCents: number }
	/** No order for this payment intent yet — remembered for when it arrives. */
	| { kind: 'refund-pending'; paymentIntent: string }
	/** A refund without a payment intent cannot be keyed to anything. */
	| { kind: 'refund-unmatched' }
	/** Delayed payment method settled: pending → paid (+ invoice, email, nurture). */
	| { kind: 'payment-succeeded'; orderId: string }
	/** Delayed payment method failed: pending → failed, stock restored, cancelled. */
	| { kind: 'payment-failed'; orderId: string }
	/** An async result for an order that is no longer pending — nothing to do. */
	| { kind: 'payment-already-settled'; orderId: string; status: OrderStatus }
	| { kind: 'ignored'; type: string };

// Older API versions expose shipping on the session root, newer ones under
// collected_information; read both so fixtures and live events all work.
type ShippingDetails = { name?: string | null; address?: Stripe.Address | null } | null;

function extractShipping(session: Stripe.Checkout.Session): ShippingAddress | null {
	const details: ShippingDetails =
		session.collected_information?.shipping_details ??
		(session as unknown as { shipping_details?: ShippingDetails }).shipping_details ??
		null;
	if (!details?.address) return null;
	const a = details.address;
	return {
		name: details.name ?? undefined,
		line1: a.line1 ?? undefined,
		line2: a.line2 ?? undefined,
		city: a.city ?? undefined,
		state: a.state ?? undefined,
		postalCode: a.postal_code ?? undefined,
		country: a.country ?? undefined
	};
}

export { orderLookupUrl } from './order-link.ts';

function sessionPaymentIntent(session: Stripe.Checkout.Session): string | null {
	return typeof session.payment_intent === 'string'
		? session.payment_intent
		: (session.payment_intent?.id ?? null);
}

/**
 * Serialize every handler that reads or writes state keyed on one payment
 * intent (order creation, refunds) for the rest of the transaction. Without
 * it a refund and its own session delivered concurrently could each miss
 * the other's uncommitted row and the refund would be lost (audit P0 #3).
 * Transaction-scoped, so it is released at commit — safe through a
 * transaction-mode pooler, and a no-op cost on the happy path.
 */
async function lockPaymentIntent(tx: DbTx, paymentIntent: string): Promise<void> {
	await tx.execute(
		sql`select pg_advisory_xact_lock(hashtext(${`stripe-intent:${paymentIntent}`}))`
	);
}

async function sendOrderConfirmation(
	deps: WebhookDeps,
	order: {
		id: string;
		email: string;
		amountTotalCents: number;
		currency: string;
		stripeSessionId: string | null;
	},
	items: Array<{ name: string; qty: number; priceCents: number }>
): Promise<void> {
	if (!order.email) return;

	// Best-effort: a broken document layer must never block the confirmation.
	let invoiceInfo: InvoiceEmailInfo | null = null;
	if (deps.invoiceAttachment) {
		try {
			invoiceInfo = await deps.invoiceAttachment(order.id);
		} catch (err) {
			console.error(`Invoice attachment for order ${order.id} failed:`, err);
		}
	}

	const orderUrl =
		deps.publicBaseUrl && order.stripeSessionId
			? orderLookupUrl(deps.publicBaseUrl, order.stripeSessionId)
			: undefined;

	await deps.email.send({
		to: order.email,
		template: 'order-confirmation',
		data: {
			siteName: deps.siteName,
			orderId: order.id,
			items: items.map(({ name, qty, priceCents }) => ({ name, qty, priceCents })),
			totalCents: order.amountTotalCents,
			currency: order.currency,
			invoiceNumber: invoiceInfo?.displayNumber,
			orderUrl
		},
		attachments: invoiceInfo ? [invoiceInfo.attachment] : undefined,
		// The order id is stable across redeliveries — at most one email per order.
		idempotencyKey: `order-confirmation:${order.id}`
	});
}

type OrderItemSnapshot = { name: string; qty: number; priceCents: number };

interface CreatedOrder {
	order: OrderRow;
	items: OrderItemSnapshot[];
}

/**
 * The checkout effect: order + item snapshots + stock decrement + history row,
 * all through the ledger transaction. Returns null when the session id is
 * already claimed (same session under another event id).
 *
 * Consults `pending_refunds` for the session's payment intent: a refund that
 * arrived before this order (audit P0 #3) makes the order come into the
 * world already `refunded` (full) or with `refunded_cents` set (partial),
 * and the pending row is marked matched. A `paymentFailed` creation (an
 * `async_payment_failed` that beat its `completed`) is a `failed` order.
 *
 * Stock is reserved only by orders that may still ship — `paid` and
 * `pending`; a failed payment or an order dead on arrival never consumed goods.
 */
async function createOrderFromSession(
	tx: DbTx,
	session: Stripe.Checkout.Session,
	cart: ReturnType<typeof parseCartMetadata>,
	opts: { paymentFailed?: boolean } = {}
): Promise<CreatedOrder | null> {
	const paymentIntent = sessionPaymentIntent(session);
	if (paymentIntent) await lockPaymentIntent(tx, paymentIntent);

	const goodsFromCart = cart.reduce((sum, item) => sum + item.p * item.q, 0);
	// Stripe's shipping_cost is the authority on what was charged for delivery;
	// the metadata snapshot (what WE quoted at session creation — the session
	// carries exactly that one option) is the fallback for older payloads.
	const shippingMeta = parseShippingMetadata(session.metadata?.[SHIPPING_METADATA_KEY]);
	const shippingCents = session.shipping_cost?.amount_total ?? shippingMeta?.priceCents ?? 0;
	const status: OrderStatus = opts.paymentFailed
		? 'failed'
		: session.payment_status === 'paid'
			? 'paid'
			: 'pending';

	// Claim the session id by insert: the unique constraint makes duplicate
	// (and concurrent) deliveries collapse to exactly one order.
	const [inserted] = await tx
		.insert(orders)
		.values({
			id: crypto.randomUUID(),
			// Lowercased at write time so GDPR erasure and any email join match
			// case-insensitively (audit 2026-09-03; Stripe passes it as typed).
			email: session.customer_details?.email?.toLowerCase() ?? '',
			stripeSessionId: session.id,
			stripePaymentIntent: paymentIntent,
			amountTotalCents: session.amount_total ?? goodsFromCart + shippingCents,
			shippingCents,
			shippingName: shippingMeta?.name ?? '',
			currency: session.currency ?? 'ron',
			status,
			shippingAddress: extractShipping(session),
			billingCompany: parseBuyerCompanyMetadata(session.metadata?.[BUYER_COMPANY_METADATA_KEY])
		})
		.onConflictDoNothing({ target: orders.stripeSessionId })
		.returning();
	if (!inserted) return null;
	let order = inserted;

	// A refund that beat its own order: apply it before anything else looks
	// at the status (stock, invoice, email all key on it).
	let pending: PendingRefundRow | undefined;
	if (paymentIntent && !opts.paymentFailed) {
		[pending] = await tx
			.select()
			.from(pendingRefunds)
			.where(and(eq(pendingRefunds.paymentIntent, paymentIntent), isNull(pendingRefunds.matchedAt)))
			.for('update');
	}
	const fullyRefunded = !!pending && pending.amountRefundedCents >= pending.amountCents;
	if (pending && paymentIntent) {
		[order] = await tx
			.update(orders)
			.set({
				status: fullyRefunded ? 'refunded' : order.status,
				refundedCents: fullyRefunded
					? Math.max(pending.amountRefundedCents, order.amountTotalCents)
					: pending.amountRefundedCents
			})
			.where(eq(orders.id, order.id))
			.returning();
		await tx
			.update(pendingRefunds)
			.set({ matchedAt: new Date(), orderId: order.id })
			.where(eq(pendingRefunds.paymentIntent, paymentIntent));
	}

	const productRows = await tx
		.select({ id: products.id, name: products.name })
		.from(products)
		.where(
			inArray(
				products.id,
				cart.map((item) => item.i)
			)
		);
	const nameById = new Map(productRows.map((r) => [r.id, r.name]));

	const items = cart.map((item) => ({
		id: crypto.randomUUID(),
		orderId: order.id,
		productId: nameById.has(item.i) ? item.i : null,
		name: nameById.get(item.i) ?? 'Produs',
		priceCents: item.p,
		qty: item.q
	}));
	await tx.insert(orderItems).values(items);

	// Decrement tracked stock; untracked (null) stock is left alone. The
	// un-floored RETURNING exposes overselling (audit resilience #7): stock
	// is only checked BEFORE payment, so two concurrent checkouts can both
	// pass with one unit left. Clamp back to 0 and flag the order — a human
	// decides between restock, partial refund or apology; auto-refunding a
	// whole (possibly multi-line) paid order here would be worse. The row
	// stays locked by the first update, so the clamp cannot race.
	let oversold = false;
	if (order.status === 'paid' || order.status === 'pending') {
		for (const item of cart) {
			const [updated] = await tx
				.update(products)
				.set({ stock: sql`${products.stock} - ${item.q}` })
				.where(and(eq(products.id, item.i), isNotNull(products.stock)))
				.returning({ id: products.id, stock: products.stock });
			// stock is non-null here (the WHERE filters untracked rows).
			if (updated?.stock != null && updated.stock < 0) {
				oversold = true;
				await tx.update(products).set({ stock: 0 }).where(eq(products.id, updated.id));
			}
		}
		if (oversold) {
			await tx.update(orders).set({ oversold: true }).where(eq(orders.id, order.id));
		}
	}

	await appendOrderEvent(tx, {
		orderId: order.id,
		kind: 'created',
		actor: WEBHOOK_ACTOR,
		note: session.id
	});
	if (pending) {
		await appendOrderEvent(tx, {
			orderId: order.id,
			kind: fullyRefunded ? 'refund-marked' : 'refund-partial',
			actor: WEBHOOK_ACTOR,
			note: `${pending.chargeId}: ${pending.amountRefundedCents}/${pending.amountCents} (refund received before the order)`
		});
	}

	return { order: { ...order, oversold }, items };
}

/**
 * The fiscal side of a settled order, inside the caller's ledger transaction:
 * a paid order gets its invoice; a refunded one its invoice AND the storno.
 * A validation failure (e.g. issuer settings still placeholders) must never
 * fail the ORDER: it is recorded on the event trail, surfaced in the admin
 * work queue, and retried there in one click.
 */
async function issueFiscalDocumentsInTx(
	tx: DbTx,
	order: OrderRow,
	items: OrderItemSnapshot[],
	settings: SiteSettings
): Promise<void> {
	if (order.status !== 'paid' && order.status !== 'refunded') return;
	const issued = await issueInvoiceForOrderInTx(tx, order, items, settings, WEBHOOK_ACTOR);
	if (!issued.ok) {
		await appendOrderEvent(tx, {
			orderId: order.id,
			kind: 'invoice-failed',
			actor: WEBHOOK_ACTOR,
			note: issued.detail ? `${issued.error}: ${issued.detail}` : issued.error
		});
		return;
	}
	if (order.status === 'refunded') {
		const reversed = await issueStornoForOrderInTx(tx, order, WEBHOOK_ACTOR);
		if (!reversed.ok) {
			await appendOrderEvent(tx, {
				orderId: order.id,
				kind: 'storno-failed',
				actor: WEBHOOK_ACTOR,
				note: reversed.detail ? `${reversed.error}: ${reversed.detail}` : reversed.error
			});
		}
	}
}

/**
 * Everything that happens AFTER a paid order committed — deliberately outside
 * the transaction: a mail failure must never roll back a paid order (Stripe's
 * redelivery retries the idempotent send instead). Only a PAID order gets
 * the confirmation and the nurture trigger: a pending one is not paid yet,
 * a refunded or failed one never will be.
 */
async function afterOrderCommitted(
	deps: WebhookDeps,
	order: OrderRow,
	items: OrderItemSnapshot[]
): Promise<void> {
	if (order.status !== 'paid') return;
	await sendOrderConfirmation(deps, order, items);
	// Nurture order-paid trigger, best-effort: enrollment is idempotent
	// (unique per sequence+subscriber) and consent-gated inside; a failure
	// here must never turn a processed payment into a webhook error.
	if (order.email) {
		try {
			await enrollFromOrderEmail({ db: deps.db }, order.email);
		} catch (err) {
			console.error(`Nurture enrollment for order ${order.id} failed:`, err);
		}
	}
}

/**
 * On a redelivery the only work possibly left undone is the post-commit
 * email, so re-attempt it for a PAID order — idempotency skips it unless the
 * previous attempt failed (or never happened).
 */
async function retryConfirmationForSession(deps: WebhookDeps, sessionId: string): Promise<void> {
	const existing = await getOrderBySessionId(deps, sessionId);
	if (existing && existing.order.status === 'paid') {
		await sendOrderConfirmation(deps, existing.order, existing.items);
	}
}

function reportEmptyCart(session: Stripe.Checkout.Session): void {
	// Loud on purpose: a completed session we cannot turn into an order means
	// a customer paid for nothing we can ship. The ledger row (outcome
	// `empty-cart`) keeps the event id for the admin; the log line carries
	// what the ledger does not — the session and the amount.
	console.error(
		`Stripe session ${session.id} completed without a cart snapshot ` +
			`(amount_total ${session.amount_total ?? 'unknown'} ${session.currency ?? ''}, ` +
			`payment_intent ${sessionPaymentIntent(session) ?? 'none'}) — no order was created`
	);
}

async function handleCheckoutCompleted(
	deps: WebhookDeps,
	event: Stripe.Event,
	session: Stripe.Checkout.Session
): Promise<WebhookOutcome> {
	const cart = parseCartMetadata(session.metadata?.[CART_METADATA_KEY]);
	// Loaded outside the ledger transaction (read-only, no need for the lock).
	const settings = await loadSettings(deps);

	// All-or-nothing: the ledger claim, the session-id claim, the item
	// snapshots, the stock decrement, the history row AND the invoice commit
	// together or not at all. A mid-flight failure rolls back the ledger row
	// too, so Stripe's redelivery retries the whole unit instead of hitting a
	// headless "already processed".
	const result = await runOnce(
		deps.db,
		{ provider: 'stripe', eventId: event.id, eventType: event.type },
		async (tx) => {
			if (cart.length === 0) return { outcome: 'empty-cart', value: null };
			const created = await createOrderFromSession(tx, session, cart);
			if (!created) return { outcome: 'duplicate-session', value: null };
			await issueFiscalDocumentsInTx(tx, created.order, created.items, settings);
			if (created.order.status === 'refunded') {
				// Money already returned before the order existed: it will never
				// be fulfilled (no AWB can exist yet → fulfillment cancelled).
				await applyRefundShipmentInTx(tx, created.order, WEBHOOK_ACTOR);
			}
			return { outcome: 'order-created', value: created };
		}
	);

	if (!result.duplicate && result.value) {
		await afterOrderCommitted(deps, result.value.order, result.value.items);
		return {
			kind: 'order-created',
			orderId: result.value.order.id,
			status: result.value.order.status
		};
	}
	if (!result.duplicate && result.outcome === 'empty-cart') {
		reportEmptyCart(session);
		return { kind: 'empty-cart', sessionId: session.id };
	}

	// Redelivery (same event id) or the same session under a new event id.
	await retryConfirmationForSession(deps, session.id);
	return result.duplicate
		? { kind: 'duplicate-event', eventId: event.id, firstOutcome: result.outcome }
		: { kind: 'duplicate-session', sessionId: session.id };
}

/**
 * `checkout.session.async_payment_succeeded`: a delayed payment method
 * (bank debit, voucher…) settled. Usually the order exists as `pending` from
 * the `completed` event and is flipped to paid here — invoice, confirmation
 * email and nurture follow exactly as for a card payment. If this event
 * arrives FIRST, it carries the same session object, so the order is created
 * from it directly (paid); the later `completed` is then a duplicate session.
 */
async function handleAsyncPaymentSucceeded(
	deps: WebhookDeps,
	event: Stripe.Event,
	session: Stripe.Checkout.Session
): Promise<WebhookOutcome> {
	const cart = parseCartMetadata(session.metadata?.[CART_METADATA_KEY]);
	const settings = await loadSettings(deps);

	type Settled = {
		kind: 'created' | 'flipped' | 'already';
		order: OrderRow;
		items: OrderItemSnapshot[];
	};
	const result = await runOnce(
		deps.db,
		{ provider: 'stripe', eventId: event.id, eventType: event.type },
		async (tx): Promise<{ outcome: string; value: Settled | null }> => {
			let [existing] = await tx
				.select()
				.from(orders)
				.where(eq(orders.stripeSessionId, session.id))
				.for('update');
			if (!existing) {
				if (cart.length === 0) return { outcome: 'empty-cart', value: null };
				const created = await createOrderFromSession(
					tx,
					{ ...session, payment_status: 'paid' },
					cart
				);
				if (created) {
					await issueFiscalDocumentsInTx(tx, created.order, created.items, settings);
					if (created.order.status === 'refunded') {
						await applyRefundShipmentInTx(tx, created.order, WEBHOOK_ACTOR);
					}
					return { outcome: 'order-created', value: { kind: 'created', ...created } };
				}
				// Lost the session claim to a concurrent `completed` delivery,
				// which has committed by now — re-read and flip it below.
				[existing] = await tx
					.select()
					.from(orders)
					.where(eq(orders.stripeSessionId, session.id))
					.for('update');
				if (!existing) throw new Error(`session ${session.id} claimed but no order row found`);
			}
			const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, existing.id));
			if (existing.status !== 'pending') {
				return {
					outcome: 'payment-already-settled',
					value: { kind: 'already', order: existing, items }
				};
			}
			const [order] = await tx
				.update(orders)
				.set({ status: 'paid' })
				.where(eq(orders.id, existing.id))
				.returning();
			await appendOrderEvent(tx, {
				orderId: order.id,
				kind: 'payment-succeeded',
				actor: WEBHOOK_ACTOR,
				note: session.id
			});
			await issueFiscalDocumentsInTx(tx, order, items, settings);
			return { outcome: 'payment-succeeded', value: { kind: 'flipped', order, items } };
		}
	);

	if (result.duplicate) {
		await retryConfirmationForSession(deps, session.id);
		return { kind: 'duplicate-event', eventId: event.id, firstOutcome: result.outcome };
	}
	if (!result.value) {
		reportEmptyCart(session);
		return { kind: 'empty-cart', sessionId: session.id };
	}
	const { order, items } = result.value;
	if (result.value.kind === 'already') {
		// A paid order whose confirmation may still be owed (e.g. a failed send).
		await retryConfirmationForSession(deps, session.id);
		return { kind: 'payment-already-settled', orderId: order.id, status: order.status };
	}
	await afterOrderCommitted(deps, order, items);
	return result.value.kind === 'created'
		? { kind: 'order-created', orderId: order.id, status: order.status }
		: { kind: 'payment-succeeded', orderId: order.id };
}

/**
 * Give the units a pending order reserved back to the catalog. An oversold
 * order's decrement was clamped at zero, so the exact reservation is unknown
 * — nothing is restored and the trail says so; a human reconciles.
 */
async function restoreStockInTx(tx: DbTx, order: OrderRow): Promise<boolean> {
	if (order.oversold) return false;
	const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
	for (const item of items) {
		if (!item.productId) continue;
		await tx
			.update(products)
			.set({ stock: sql`${products.stock} + ${item.qty}` })
			.where(and(eq(products.id, item.productId), isNotNull(products.stock)));
	}
	return true;
}

/**
 * `checkout.session.async_payment_failed`: the delayed payment did not go
 * through. The pending order becomes `failed`, its reserved stock returns to
 * the catalog and fulfillment is cancelled. Arriving first, it creates the
 * order as `failed` (no stock taken) so the later `completed` cannot create a
 * pending one; a settled order is never touched.
 */
async function handleAsyncPaymentFailed(
	deps: WebhookDeps,
	event: Stripe.Event,
	session: Stripe.Checkout.Session
): Promise<WebhookOutcome> {
	const cart = parseCartMetadata(session.metadata?.[CART_METADATA_KEY]);

	type Failed = { order: OrderRow; changed: boolean };
	const result = await runOnce(
		deps.db,
		{ provider: 'stripe', eventId: event.id, eventType: event.type },
		async (tx): Promise<{ outcome: string; value: Failed | null }> => {
			let [existing] = await tx
				.select()
				.from(orders)
				.where(eq(orders.stripeSessionId, session.id))
				.for('update');
			if (!existing) {
				if (cart.length === 0) return { outcome: 'empty-cart', value: null };
				const created = await createOrderFromSession(tx, session, cart, { paymentFailed: true });
				if (created) {
					const cancelled = await applyFulfillmentTransitionInTx(tx, created.order, 'cancelled', {
						actor: WEBHOOK_ACTOR,
						note: 'payment failed'
					});
					await appendOrderEvent(tx, {
						orderId: created.order.id,
						kind: 'payment-failed',
						actor: WEBHOOK_ACTOR,
						note: `${session.id} (failure received before the order; no stock taken)`
					});
					return {
						outcome: 'payment-failed',
						value: { order: cancelled.ok ? cancelled.order : created.order, changed: true }
					};
				}
				[existing] = await tx
					.select()
					.from(orders)
					.where(eq(orders.stripeSessionId, session.id))
					.for('update');
				if (!existing) throw new Error(`session ${session.id} claimed but no order row found`);
			}
			if (existing.status !== 'pending') {
				return { outcome: 'payment-already-settled', value: { order: existing, changed: false } };
			}
			let [order] = await tx
				.update(orders)
				.set({ status: 'failed' })
				.where(eq(orders.id, existing.id))
				.returning();
			const restored = await restoreStockInTx(tx, order);
			await appendOrderEvent(tx, {
				orderId: order.id,
				kind: 'payment-failed',
				actor: WEBHOOK_ACTOR,
				note: restored
					? `${session.id} (stock restored)`
					: `${session.id} (oversold order — stock NOT restored, reconcile by hand)`
			});
			if (canTransition(order.fulfillmentStatus, 'cancelled')) {
				const cancelled = await applyFulfillmentTransitionInTx(tx, order, 'cancelled', {
					actor: WEBHOOK_ACTOR,
					note: 'payment failed'
				});
				if (cancelled.ok) order = cancelled.order;
			}
			return { outcome: 'payment-failed', value: { order, changed: true } };
		}
	);

	if (result.duplicate) {
		return { kind: 'duplicate-event', eventId: event.id, firstOutcome: result.outcome };
	}
	if (!result.value) {
		reportEmptyCart(session);
		return { kind: 'empty-cart', sessionId: session.id };
	}
	return result.value.changed
		? { kind: 'payment-failed', orderId: result.value.order.id }
		: {
				kind: 'payment-already-settled',
				orderId: result.value.order.id,
				status: result.value.order.status
			};
}

/**
 * What a `charge.refunded` says about the money. `amount_refunded` is
 * CUMULATIVE (the total refunded on the charge so far); a refund is partial
 * while it is below the charge amount. Payloads without the two fields (only
 * hand-built ones — Stripe always sends both) count as full, today's path.
 */
function refundAmounts(charge: Stripe.Charge): {
	amountCents: number | null;
	refundedCents: number | null;
	full: boolean;
} {
	const amountCents = Number.isInteger(charge.amount) ? charge.amount : null;
	const refundedCents = Number.isInteger(charge.amount_refunded) ? charge.amount_refunded : null;
	const full = amountCents === null || refundedCents === null || refundedCents >= amountCents;
	return { amountCents, refundedCents, full };
}

/**
 * Remember a refund whose order does not exist (yet). Keyed by payment
 * intent; a later event for the same intent raises the cumulative amounts
 * (never lowers them — deliveries may be reordered) and re-opens the row.
 */
async function rememberPendingRefund(
	tx: DbTx,
	input: { paymentIntent: string; chargeId: string; amountCents: number; refundedCents: number }
): Promise<void> {
	await tx
		.insert(pendingRefunds)
		.values({
			paymentIntent: input.paymentIntent,
			chargeId: input.chargeId,
			amountCents: input.amountCents,
			amountRefundedCents: input.refundedCents
		})
		.onConflictDoUpdate({
			target: pendingRefunds.paymentIntent,
			set: {
				chargeId: sql`excluded.charge_id`,
				amountCents: sql`greatest(${pendingRefunds.amountCents}, excluded.amount_cents)`,
				amountRefundedCents: sql`greatest(${pendingRefunds.amountRefundedCents}, excluded.amount_refunded_cents)`,
				receivedAt: sql`least(${pendingRefunds.receivedAt}, excluded.received_at)`,
				matchedAt: null,
				orderId: null
			}
		});
}

async function handleChargeRefunded(
	deps: WebhookDeps,
	event: Stripe.Event,
	charge: Stripe.Charge
): Promise<WebhookOutcome> {
	const paymentIntent =
		typeof charge.payment_intent === 'string'
			? charge.payment_intent
			: (charge.payment_intent?.id ?? null);
	const { amountCents, refundedCents, full } = refundAmounts(charge);

	type RefundEffect =
		| { kind: 'partial'; orderId: string; refundedCents: number }
		| { kind: 'full'; orderId: string; cancelAwb: string | null }
		| { kind: 'pending'; paymentIntent: string };

	const result = await runOnce(
		deps.db,
		{ provider: 'stripe', eventId: event.id, eventType: event.type },
		async (tx): Promise<{ outcome: string; value: RefundEffect | null }> => {
			if (!paymentIntent) return { outcome: 'refund-unmatched', value: null };
			await lockPaymentIntent(tx, paymentIntent);

			if (!full) {
				// Partial (audit P0 #2): the customer keeps (some of) the goods —
				// only the amount moves. No storno (the operator issues a partial
				// one from the order page), no fulfillment or AWB change.
				const [order] = await tx
					.update(orders)
					.set({ refundedCents: sql`greatest(${orders.refundedCents}, ${refundedCents})` })
					.where(eq(orders.stripePaymentIntent, paymentIntent))
					.returning();
				if (!order) {
					await rememberPendingRefund(tx, {
						paymentIntent,
						chargeId: charge.id,
						amountCents: amountCents ?? 0,
						refundedCents: refundedCents ?? 0
					});
					return { outcome: 'refund-pending', value: { kind: 'pending', paymentIntent } };
				}
				await appendOrderEvent(tx, {
					orderId: order.id,
					kind: 'refund-partial',
					actor: WEBHOOK_ACTOR,
					note: `${charge.id}: ${refundedCents}/${amountCents}`
				});
				return {
					outcome: 'refund-partial',
					value: { kind: 'partial', orderId: order.id, refundedCents: order.refundedCents }
				};
			}

			const [order] = await tx
				.update(orders)
				.set({
					status: 'refunded',
					refundedCents: sql`greatest(${orders.refundedCents}, coalesce(${refundedCents}, ${orders.amountTotalCents}))`
				})
				.where(eq(orders.stripePaymentIntent, paymentIntent))
				.returning();
			if (!order) {
				await rememberPendingRefund(tx, {
					paymentIntent,
					chargeId: charge.id,
					amountCents: amountCents ?? refundedCents ?? 0,
					refundedCents: refundedCents ?? amountCents ?? 0
				});
				return { outcome: 'refund-pending', value: { kind: 'pending', paymentIntent } };
			}
			await appendOrderEvent(tx, {
				orderId: order.id,
				kind: 'refund-marked',
				actor: WEBHOOK_ACTOR,
				note: charge.id
			});
			// A refund reverses the fiscal record: issue the storno with the
			// status flip — of the whole invoice, or of the remainder after an
			// earlier partial storno. No invoice to reverse (its issuance failed
			// earlier) is recorded, not fatal — the admin retry issues both.
			const reversed = await issueStornoForOrderInTx(tx, order, WEBHOOK_ACTOR);
			if (!reversed.ok) {
				await appendOrderEvent(tx, {
					orderId: order.id,
					kind: 'storno-failed',
					actor: WEBHOOK_ACTOR,
					note: reversed.detail ? `${reversed.error}: ${reversed.detail}` : reversed.error
				});
			}
			// Refund vs fulfillment/shipment (NEXT-8 rule): before an AWB exists
			// the order is cancelled; after one, it is marked returned and a
			// not-yet-picked-up AWB is flagged for courier cancellation (below).
			const plan = await applyRefundShipmentInTx(tx, order, WEBHOOK_ACTOR);
			return {
				outcome: 'refund-marked',
				value: { kind: 'full', orderId: order.id, cancelAwb: plan.cancelAwb }
			};
		}
	);

	if (result.duplicate) {
		return { kind: 'duplicate-event', eventId: event.id, firstOutcome: result.outcome };
	}
	if (!result.value) return { kind: 'refund-unmatched' };
	const effect = result.value;
	if (effect.kind === 'pending')
		return { kind: 'refund-pending', paymentIntent: effect.paymentIntent };
	if (effect.kind === 'partial') {
		return { kind: 'refund-partial', orderId: effect.orderId, refundedCents: effect.refundedCents };
	}
	// Deliberately AFTER the commit: a courier API failure must never roll back
	// the refund bookkeeping — it is recorded on the trail for manual follow-up.
	if (effect.cancelAwb && deps.courier) {
		await cancelShipmentBestEffort(
			{ db: deps.db, courier: deps.courier },
			effect.orderId,
			effect.cancelAwb,
			WEBHOOK_ACTOR
		);
	}
	return { kind: 'refund-marked', orderId: effect.orderId };
}

/**
 * Dispatch a VERIFIED event. Unknown event types are acknowledged and ignored
 * without touching the ledger — there is no effect to guard, and recording
 * them would grow the table with every event category Stripe adds.
 */
export async function processStripeEvent(
	deps: WebhookDeps,
	event: Stripe.Event
): Promise<WebhookOutcome> {
	switch (event.type) {
		case 'checkout.session.completed':
			return handleCheckoutCompleted(deps, event, event.data.object);
		case 'checkout.session.async_payment_succeeded':
			return handleAsyncPaymentSucceeded(deps, event, event.data.object);
		case 'checkout.session.async_payment_failed':
			return handleAsyncPaymentFailed(deps, event, event.data.object);
		case 'charge.refunded':
			return handleChargeRefunded(deps, event, event.data.object);
		default:
			return { kind: 'ignored', type: event.type };
	}
}

/** An order with its item snapshots, for the success page and admin detail. */
export async function getOrderWithItems(deps: Pick<WebhookDeps, 'db'>, orderId: string) {
	const [order] = await deps.db.select().from(orders).where(eq(orders.id, orderId));
	if (!order) return null;
	const items = await deps.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
	return { order, items };
}

export async function getOrderBySessionId(deps: Pick<WebhookDeps, 'db'>, sessionId: string) {
	const [order] = await deps.db.select().from(orders).where(eq(orders.stripeSessionId, sessionId));
	if (!order) return null;
	const items = await deps.db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
	return { order, items };
}

/** Refunds still waiting for their order — the operator's "money went back, for what?" list. */
export function listUnmatchedRefunds(deps: Pick<WebhookDeps, 'db'>): Promise<PendingRefundRow[]> {
	return deps.db
		.select()
		.from(pendingRefunds)
		.where(isNull(pendingRefunds.matchedAt))
		.orderBy(desc(pendingRefunds.receivedAt));
}

/**
 * Completed sessions that carried no cart snapshot and so created no order —
 * the ledger keeps the event id (the session id and amount are in the error
 * log line); the admin sees them next to the work queue.
 */
export function listEmptyCartEvents(
	deps: Pick<WebhookDeps, 'db'>,
	limit = 20
): Promise<ProcessedEventRow[]> {
	return deps.db
		.select()
		.from(processedEvents)
		.where(and(eq(processedEvents.provider, 'stripe'), eq(processedEvents.outcome, 'empty-cart')))
		.orderBy(desc(processedEvents.receivedAt))
		.limit(limit);
}

/**
 * Admin order listing with the work-queue filters:
 * - `action` (the default daily view): paid orders whose goods have not left
 *   yet (`unfulfilled`/`packed`) — exactly the rows an operator must touch,
 *   oversold and partially refunded ones included;
 * - `oversold`: flagged orders still in a pre-shipping state — the ones where
 *   restock / partial refund / apology is still undecided;
 * - `invoice-missing`: orders whose fiscal record is incomplete — paid or
 *   refunded without an invoice (issuance failed), or refunded without the
 *   stornos adding up to the invoice — each fixable with the detail page's
 *   one-click issue action;
 * - a single fulfillment status; or `all`.
 */
export type OrderListFilter = 'all' | 'action' | 'oversold' | 'invoice-missing' | FulfillmentStatus;

export const ORDER_LIST_FILTERS: readonly OrderListFilter[] = [
	'action',
	'oversold',
	'invoice-missing',
	'all',
	...FULFILLMENT_STATUSES
];

export function isOrderListFilter(value: unknown): value is OrderListFilter {
	return (ORDER_LIST_FILTERS as readonly unknown[]).includes(value);
}

const NEEDS_ACTION_STATES: FulfillmentStatus[] = ['unfulfilled', 'packed'];

// The order's invoice, for the fiscal-document columns in listOrders. Stornos
// are aggregated in subqueries: several may reference one invoice (partial
// refunds), and a join would multiply the order row.
const orderInvoice = alias(invoices, 'order_invoice');
const stornoNumbers = sql<
	string | null
>`(select string_agg(s.display_number, ', ' order by s.number) from invoices s where s.storno_of_invoice_id = ${orderInvoice.id})`;
const reversedCents = sql<number>`coalesce((select sum(-s.gross_total_cents) from invoices s where s.storno_of_invoice_id = ${orderInvoice.id}), 0)::int`;
/** The single definition of "fiscal record incomplete" — filter and badge agree. */
const fiscalIncomplete = sql<boolean>`case
	when ${orders.status} = 'paid' then ${orderInvoice.id} is null
	when ${orders.status} = 'refunded' then (${orderInvoice.id} is null or ${reversedCents} < ${orderInvoice.grossTotalCents})
	else false end`;

function orderFilterCondition(filter: OrderListFilter) {
	switch (filter) {
		case 'all':
			return undefined;
		case 'action':
			return and(eq(orders.status, 'paid'), inArray(orders.fulfillmentStatus, NEEDS_ACTION_STATES));
		case 'oversold':
			return and(eq(orders.oversold, true), inArray(orders.fulfillmentStatus, NEEDS_ACTION_STATES));
		case 'invoice-missing':
			return fiscalIncomplete;
		default:
			return eq(orders.fulfillmentStatus, filter);
	}
}

export type OrderListRow = OrderRow & {
	/** Display number of the order's invoice; null = not issued. */
	invoiceNumber: string | null;
	/** Display numbers of its stornos, comma-joined in issue order; null = none. */
	stornoNumber: string | null;
	/** What the stornos reverse so far, positive bani (0 = none). */
	reversedCents: number;
	/** The fiscal record needs the operator: see `invoice-missing`. */
	fiscalIncomplete: boolean;
};

export function listOrders(
	deps: Pick<WebhookDeps, 'db'>,
	filter: OrderListFilter = 'all'
): Promise<OrderListRow[]> {
	return deps.db
		.select({
			...getTableColumns(orders),
			invoiceNumber: orderInvoice.displayNumber,
			stornoNumber: stornoNumbers,
			reversedCents: reversedCents.mapWith(Number),
			fiscalIncomplete: fiscalIncomplete.mapWith(Boolean)
		})
		.from(orders)
		.leftJoin(
			orderInvoice,
			and(eq(orderInvoice.orderId, orders.id), eq(orderInvoice.kind, 'invoice'))
		)
		.where(orderFilterCondition(filter))
		.orderBy(desc(orders.createdAt), desc(orders.id));
}
