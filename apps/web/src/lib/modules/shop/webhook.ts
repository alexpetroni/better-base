import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import Stripe from 'stripe';
import type { Db } from '../../db/client.ts';
import { runOnce, type DbTx } from '../../server/event-ledger/core.ts';
import type { EmailSender } from '../email/service.ts';
import { issueInvoiceForOrderInTx, issueStornoForOrderInTx } from '$lib/modules/invoice/server';
import { loadSettings } from '$lib/modules/settings/server';
import { invoices } from '../invoice/schema.ts';
import {
	parseBuyerCompanyMetadata,
	parseCartMetadata,
	BUYER_COMPANY_METADATA_KEY,
	CART_METADATA_KEY
} from './checkout.ts';
import { appendOrderEvent } from './fulfillment-service.ts';
import { FULFILLMENT_STATUSES, type FulfillmentStatus } from './fulfillment.ts';
import { orderItems, orders, products, type OrderRow, type ShippingAddress } from './schema.ts';

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

export interface WebhookDeps {
	db: Db;
	email: EmailSender;
	siteName: string;
}

export type WebhookOutcome =
	| { kind: 'order-created'; orderId: string }
	/** Same provider event id delivered again — the ledger skipped the effect. */
	| { kind: 'duplicate-event'; eventId: string; firstOutcome: string }
	/** Same checkout session under a NEW event id — the order already exists. */
	| { kind: 'duplicate-session'; sessionId: string }
	| { kind: 'empty-cart'; sessionId: string }
	| { kind: 'refund-marked'; orderId: string }
	| { kind: 'refund-unmatched' }
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

async function sendOrderConfirmation(
	deps: WebhookDeps,
	order: { id: string; email: string; amountTotalCents: number; currency: string },
	items: Array<{ name: string; qty: number; priceCents: number }>
): Promise<void> {
	if (!order.email) return;
	await deps.email.send({
		to: order.email,
		template: 'order-confirmation',
		data: {
			siteName: deps.siteName,
			orderId: order.id,
			items: items.map(({ name, qty, priceCents }) => ({ name, qty, priceCents })),
			totalCents: order.amountTotalCents,
			currency: order.currency
		},
		// The order id is stable across redeliveries — at most one email per order.
		idempotencyKey: `order-confirmation:${order.id}`
	});
}

type OrderItemSnapshot = { name: string; qty: number; priceCents: number };

/**
 * The checkout effect: order + item snapshots + stock decrement + history row,
 * all through the ledger transaction. Returns null when the session id is
 * already claimed (same session under another event id).
 */
async function createOrderFromSession(
	tx: DbTx,
	session: Stripe.Checkout.Session,
	cart: ReturnType<typeof parseCartMetadata>
): Promise<{ order: OrderRow; items: OrderItemSnapshot[] } | null> {
	const paymentIntent =
		typeof session.payment_intent === 'string'
			? session.payment_intent
			: (session.payment_intent?.id ?? null);
	const amountFromCart = cart.reduce((sum, item) => sum + item.p * item.q, 0);

	// Claim the session id by insert: the unique constraint makes duplicate
	// (and concurrent) deliveries collapse to exactly one order.
	const [order] = await tx
		.insert(orders)
		.values({
			id: crypto.randomUUID(),
			email: session.customer_details?.email ?? '',
			stripeSessionId: session.id,
			stripePaymentIntent: paymentIntent,
			amountTotalCents: session.amount_total ?? amountFromCart,
			currency: session.currency ?? 'ron',
			status: session.payment_status === 'paid' ? 'paid' : 'pending',
			shippingAddress: extractShipping(session),
			billingCompany: parseBuyerCompanyMetadata(session.metadata?.[BUYER_COMPANY_METADATA_KEY])
		})
		.onConflictDoNothing({ target: orders.stripeSessionId })
		.returning();
	if (!order) return null;

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

	await appendOrderEvent(tx, {
		orderId: order.id,
		kind: 'created',
		actor: WEBHOOK_ACTOR,
		note: session.id
	});

	return { order: { ...order, oversold }, items };
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
			// Issue the invoice with the order (paid orders only — an async
			// payment still pending gets its invoice when it is marked paid).
			// A validation failure (e.g. issuer settings still placeholders)
			// must never fail the ORDER: it is recorded on the event trail,
			// surfaced in the admin work queue, and retried there in one click.
			if (created.order.status === 'paid') {
				const issued = await issueInvoiceForOrderInTx(
					tx,
					created.order,
					created.items,
					settings,
					WEBHOOK_ACTOR
				);
				if (!issued.ok) {
					await appendOrderEvent(tx, {
						orderId: created.order.id,
						kind: 'invoice-failed',
						actor: WEBHOOK_ACTOR,
						note: issued.detail ? `${issued.error}: ${issued.detail}` : issued.error
					});
				}
			}
			return { outcome: 'order-created', value: created };
		}
	);

	if (!result.duplicate && result.value) {
		// Deliberately AFTER the commit: a mail failure must never roll back a
		// paid order — Stripe's redelivery retries the (idempotent) send instead.
		await sendOrderConfirmation(deps, result.value.order, result.value.items);
		return { kind: 'order-created', orderId: result.value.order.id };
	}
	if (!result.duplicate && result.outcome === 'empty-cart') {
		return { kind: 'empty-cart', sessionId: session.id };
	}

	// Redelivery (same event id) or the same session under a new event id:
	// the only work possibly left undone is the post-commit email, so
	// re-attempt it — idempotency skips it unless the previous attempt failed
	// (or never happened).
	const existing = await getOrderBySessionId(deps, session.id);
	if (existing) await sendOrderConfirmation(deps, existing.order, existing.items);
	return result.duplicate
		? { kind: 'duplicate-event', eventId: event.id, firstOutcome: result.outcome }
		: { kind: 'duplicate-session', sessionId: session.id };
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

	const result = await runOnce(
		deps.db,
		{ provider: 'stripe', eventId: event.id, eventType: event.type },
		async (tx) => {
			if (!paymentIntent) return { outcome: 'refund-unmatched', value: null };
			const [order] = await tx
				.update(orders)
				.set({ status: 'refunded' })
				.where(eq(orders.stripePaymentIntent, paymentIntent))
				.returning();
			if (!order) return { outcome: 'refund-unmatched', value: null };
			await appendOrderEvent(tx, {
				orderId: order.id,
				kind: 'refund-marked',
				actor: WEBHOOK_ACTOR,
				note: charge.id
			});
			// A refund reverses the fiscal record: issue the storno with the
			// status flip. No invoice to reverse (its issuance failed earlier)
			// is recorded, not fatal — the admin retry issues both documents.
			const reversed = await issueStornoForOrderInTx(tx, order, WEBHOOK_ACTOR);
			if (!reversed.ok) {
				await appendOrderEvent(tx, {
					orderId: order.id,
					kind: 'storno-failed',
					actor: WEBHOOK_ACTOR,
					note: reversed.error
				});
			}
			return { outcome: 'refund-marked', value: order.id };
		}
	);

	if (result.duplicate) {
		return { kind: 'duplicate-event', eventId: event.id, firstOutcome: result.outcome };
	}
	return result.value
		? { kind: 'refund-marked', orderId: result.value }
		: { kind: 'refund-unmatched' };
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

/**
 * Admin order listing with the work-queue filters:
 * - `action` (the default daily view): paid orders whose goods have not left
 *   yet (`unfulfilled`/`packed`) — exactly the rows an operator must touch,
 *   oversold ones included;
 * - `oversold`: flagged orders still in a pre-shipping state — the ones where
 *   restock / partial refund / apology is still undecided;
 * - `invoice-missing`: orders whose fiscal record is incomplete — paid or
 *   refunded without an invoice (issuance failed), or refunded without a
 *   storno — each fixable with the detail page's one-click issue action;
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

// Aliases for the fiscal-document joins in listOrders.
const orderInvoice = alias(invoices, 'order_invoice');
const orderStorno = alias(invoices, 'order_storno');

function orderFilterCondition(filter: OrderListFilter) {
	switch (filter) {
		case 'all':
			return undefined;
		case 'action':
			return and(eq(orders.status, 'paid'), inArray(orders.fulfillmentStatus, NEEDS_ACTION_STATES));
		case 'oversold':
			return and(eq(orders.oversold, true), inArray(orders.fulfillmentStatus, NEEDS_ACTION_STATES));
		case 'invoice-missing':
			return or(
				and(inArray(orders.status, ['paid', 'refunded']), isNull(orderInvoice.id)),
				and(eq(orders.status, 'refunded'), isNotNull(orderInvoice.id), isNull(orderStorno.id))
			);
		default:
			return eq(orders.fulfillmentStatus, filter);
	}
}

export type OrderListRow = OrderRow & {
	/** Display numbers of the order's fiscal documents; null = not issued. */
	invoiceNumber: string | null;
	stornoNumber: string | null;
};

export function listOrders(
	deps: Pick<WebhookDeps, 'db'>,
	filter: OrderListFilter = 'all'
): Promise<OrderListRow[]> {
	return deps.db
		.select({
			...getTableColumns(orders),
			invoiceNumber: orderInvoice.displayNumber,
			stornoNumber: orderStorno.displayNumber
		})
		.from(orders)
		.leftJoin(
			orderInvoice,
			and(eq(orderInvoice.orderId, orders.id), eq(orderInvoice.kind, 'invoice'))
		)
		.leftJoin(orderStorno, eq(orderStorno.stornoOfInvoiceId, orderInvoice.id))
		.where(orderFilterCondition(filter))
		.orderBy(desc(orders.createdAt), desc(orders.id));
}
