import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import type { Db } from '../../db/client.ts';
import type { EmailSender } from '../email/service.ts';
import { parseCartMetadata, CART_METADATA_KEY } from './checkout.ts';
import { orderItems, orders, products, type ShippingAddress } from './schema.ts';

/**
 * Stripe webhook processing, split from the route so integration tests can
 * exercise it directly: `verifyStripeEvent` (pure signature crypto via the
 * SDK — no network) and `processStripeEvent` (order creation, stock, email).
 * Orders are idempotent on the session id: a redelivered event is a no-op.
 */

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
	| { kind: 'duplicate-session'; sessionId: string }
	| { kind: 'empty-cart'; sessionId: string }
	| { kind: 'refund-marked'; orderId: string }
	| { kind: 'refund-unmatched' }
	| { kind: 'ignored'; type: string };

/** New stock after selling `qty` units: tracked stock never goes below 0. */
export function decrementedStock(stock: number, qty: number): number {
	return Math.max(stock - qty, 0);
}

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

async function handleCheckoutCompleted(
	deps: WebhookDeps,
	session: Stripe.Checkout.Session
): Promise<WebhookOutcome> {
	const cart = parseCartMetadata(session.metadata?.[CART_METADATA_KEY]);
	if (cart.length === 0) return { kind: 'empty-cart', sessionId: session.id };

	const paymentIntent =
		typeof session.payment_intent === 'string'
			? session.payment_intent
			: (session.payment_intent?.id ?? null);
	const amountFromCart = cart.reduce((sum, item) => sum + item.p * item.q, 0);

	// Claim the session id by insert: the unique constraint makes duplicate
	// (and concurrent) deliveries collapse to exactly one order.
	const [order] = await deps.db
		.insert(orders)
		.values({
			id: crypto.randomUUID(),
			email: session.customer_details?.email ?? '',
			stripeSessionId: session.id,
			stripePaymentIntent: paymentIntent,
			amountTotalCents: session.amount_total ?? amountFromCart,
			currency: session.currency ?? 'ron',
			status: session.payment_status === 'paid' ? 'paid' : 'pending',
			shippingAddress: extractShipping(session)
		})
		.onConflictDoNothing({ target: orders.stripeSessionId })
		.returning();
	if (!order) return { kind: 'duplicate-session', sessionId: session.id };

	const productRows = await deps.db
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
	await deps.db.insert(orderItems).values(items);

	// Decrement tracked stock, floored at 0; untracked (null) stock is left alone.
	for (const item of cart) {
		await deps.db
			.update(products)
			.set({ stock: sql`greatest(${products.stock} - ${item.q}, 0)` })
			.where(and(eq(products.id, item.i), isNotNull(products.stock)));
	}

	if (order.email) {
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

	return { kind: 'order-created', orderId: order.id };
}

async function handleChargeRefunded(
	deps: WebhookDeps,
	charge: Stripe.Charge
): Promise<WebhookOutcome> {
	const paymentIntent =
		typeof charge.payment_intent === 'string'
			? charge.payment_intent
			: (charge.payment_intent?.id ?? null);
	if (!paymentIntent) return { kind: 'refund-unmatched' };
	const [order] = await deps.db
		.update(orders)
		.set({ status: 'refunded' })
		.where(eq(orders.stripePaymentIntent, paymentIntent))
		.returning();
	return order ? { kind: 'refund-marked', orderId: order.id } : { kind: 'refund-unmatched' };
}

/** Dispatch a VERIFIED event. Unknown event types are acknowledged and ignored. */
export async function processStripeEvent(
	deps: WebhookDeps,
	event: Stripe.Event
): Promise<WebhookOutcome> {
	switch (event.type) {
		case 'checkout.session.completed':
			return handleCheckoutCompleted(deps, event.data.object);
		case 'charge.refunded':
			return handleChargeRefunded(deps, event.data.object);
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
	const [order] = await deps.db
		.select()
		.from(orders)
		.where(eq(orders.stripeSessionId, sessionId));
	if (!order) return null;
	const items = await deps.db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
	return { order, items };
}

export function listOrders(deps: Pick<WebhookDeps, 'db'>) {
	return deps.db.select().from(orders).orderBy(desc(orders.createdAt), desc(orders.id));
}
