import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import { pillars } from '../../db/schema/core.ts';
import { media } from '../media/schema.ts';

/**
 * Shop: pillar-tagged products sold via Stripe Checkout. All money is integer
 * cents (bani) — no floats anywhere. Visibility on a site is decided by pillar
 * tagging (`product_pillars`), exactly like articles and quizzes: public
 * listings only show `active` products tagged to a pillar in the site config.
 */
export const products = pgTable(
	'products',
	{
		id: text('id').primaryKey(),
		slug: text('slug').notNull().unique(),
		name: text('name').notNull(),
		descriptionMd: text('description_md').notNull().default(''),
		/** Unit price in bani (RON cents). Integer only. */
		priceCents: integer('price_cents').notNull().default(0),
		currency: text('currency').notNull().default('ron'),
		/** Mirrored Stripe catalog ids, filled by the sync (null until synced). */
		stripeProductId: text('stripe_product_id'),
		stripePriceId: text('stripe_price_id'),
		status: text('status', { enum: ['draft', 'active', 'archived'] })
			.notNull()
			.default('draft'),
		coverMediaId: text('cover_media_id').references(() => media.id, { onDelete: 'set null' }),
		/** Ordered media ids for the product page gallery. */
		gallery: jsonb('gallery').$type<string[]>().notNull().default([]),
		/** Units in stock; null = stock is not tracked (always purchasable). */
		stock: integer('stock'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('products_status_idx').on(table.status),
		index('products_cover_media_id_idx').on(table.coverMediaId)
	]
);

export const productPillars = pgTable(
	'product_pillars',
	{
		productId: text('product_id')
			.notNull()
			.references(() => products.id, { onDelete: 'cascade' }),
		pillarId: integer('pillar_id')
			.notNull()
			.references(() => pillars.id, { onDelete: 'cascade' })
	},
	(table) => [
		primaryKey({ columns: [table.productId, table.pillarId] }),
		index('product_pillars_pillar_id_idx').on(table.pillarId)
	]
);

/**
 * Optional B2B billing identity, captured on the cart page before checkout
 * and carried through Stripe session metadata to the order. Snapshotted onto
 * the invoice at issue time (modules/invoice) — this copy is the working
 * record and is cleared by GDPR erasure; the invoice snapshot is retained.
 */
export interface BuyerCompany {
	name: string;
	cui?: string;
	regCom?: string;
}

/** Postal address as collected by Stripe Checkout (subset we care about). */
export interface ShippingAddress {
	name?: string;
	line1?: string;
	line2?: string;
	city?: string;
	state?: string;
	postalCode?: string;
	country?: string;
}

/**
 * Orders are created ONLY by the Stripe webhook (`checkout.session.completed`)
 * — the unique session id makes duplicate webhook deliveries idempotent.
 */
export const orders = pgTable(
	'orders',
	{
		id: text('id').primaryKey(),
		email: text('email').notNull(),
		stripeSessionId: text('stripe_session_id').notNull().unique(),
		stripePaymentIntent: text('stripe_payment_intent'),
		amountTotalCents: integer('amount_total_cents').notNull(),
		currency: text('currency').notNull(),
		status: text('status', { enum: ['pending', 'paid', 'failed', 'refunded'] })
			.notNull()
			.default('pending'),
		/**
		 * Fulfillment is a separate dimension from payment `status`: an order can
		 * be paid yet unpacked, or refunded after delivery. Written ONLY by
		 * `transitionFulfillment` (fulfillment-service.ts), which enforces the
		 * state machine in fulfillment.ts and records every change in
		 * `order_events`.
		 */
		fulfillmentStatus: text('fulfillment_status', {
			enum: ['unfulfilled', 'packed', 'shipped', 'delivered', 'returned', 'cancelled']
		})
			.notNull()
			.default('unfulfilled'),
		/**
		 * The payment claimed more units than were in stock (concurrent
		 * checkouts both passed the pre-payment stock check). Flagged by the
		 * webhook for manual follow-up — restock, partial refund, or apology.
		 */
		oversold: boolean('oversold').notNull().default(false),
		/**
		 * Shipping charged by Stripe on top of the goods, in bani (0 = free).
		 * Kept separate from `amount_total_cents` (the grand total as charged)
		 * because the invoice must carry shipping as its own VAT-bearing line.
		 */
		shippingCents: integer('shipping_cents').notNull().default(0),
		/** Display name of the delivery option chosen at checkout ('' pre-NEXT-8). */
		shippingName: text('shipping_name').notNull().default(''),
		shippingAddress: jsonb('shipping_address').$type<ShippingAddress>(),
		/** Optional company details for a B2B invoice, as entered at checkout. */
		billingCompany: jsonb('billing_company').$type<BuyerCompany>(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('orders_created_at_idx').on(table.createdAt),
		// GDPR erase anonymizes by email; the refund webhook matches by intent.
		index('orders_email_idx').on(table.email),
		index('orders_stripe_payment_intent_idx').on(table.stripePaymentIntent),
		// The admin work queue filters on the fulfillment dimension.
		index('orders_fulfillment_status_idx').on(table.fulfillmentStatus)
	]
);

/**
 * Append-only per-order history: who or what changed the order, when, and a
 * free-text note — the operator's answer to "what happened to this order".
 * Rows are only ever inserted (by the webhook and the fulfillment service);
 * invoices and AWBs hook into the same trail in later phases.
 */
export const orderEvents = pgTable(
	'order_events',
	{
		id: text('id').primaryKey(),
		orderId: text('order_id')
			.notNull()
			.references(() => orders.id, { onDelete: 'cascade' }),
		/** Machine-readable event class, e.g. `created`, `refund-marked`, `fulfillment-transition`. */
		kind: text('kind').notNull(),
		/** Staff email for admin actions; a system name (e.g. `stripe-webhook`) otherwise. */
		actor: text('actor').notNull(),
		/** Fulfillment transition endpoints; null for non-transition events. */
		fromStatus: text('from_status'),
		toStatus: text('to_status'),
		note: text('note').notNull().default(''),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [index('order_events_order_id_idx').on(table.orderId)]
);

export const orderItems = pgTable(
	'order_items',
	{
		id: text('id').primaryKey(),
		orderId: text('order_id')
			.notNull()
			.references(() => orders.id, { onDelete: 'cascade' }),
		/** Nullable: the product may be deleted later; the snapshot below survives. */
		productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
		/** Name + unit price snapshot as sold. */
		name: text('name').notNull(),
		priceCents: integer('price_cents').notNull(),
		qty: integer('qty').notNull()
	},
	(table) => [
		index('order_items_order_id_idx').on(table.orderId),
		index('order_items_product_id_idx').on(table.productId)
	]
);

/**
 * One courier shipment (AWB) per order, created by the admin "generate AWB"
 * action through the CourierProvider seam. The unique order id is the
 * idempotency backstop — pressing the button twice can never register two
 * shipments. `status` mirrors the courier's tracking state (normalized by the
 * provider adapter); the cron sync polls rows still in flight
 * (`registered`/`in-transit`) and stops once a terminal state is reached.
 */
export const shipments = pgTable(
	'shipments',
	{
		id: text('id').primaryKey(),
		orderId: text('order_id')
			.notNull()
			.references(() => orders.id, { onDelete: 'cascade' }),
		/** Courier adapter that registered the AWB (`mock` | `sameday`). */
		provider: text('provider').notNull(),
		awb: text('awb').notNull(),
		trackingUrl: text('tracking_url').notNull().default(''),
		status: text('status', {
			enum: ['registered', 'in-transit', 'delivered', 'returned', 'cancelled']
		})
			.notNull()
			.default('registered'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
		/** When the cron sync last polled this AWB; orders the per-run batch. */
		lastSyncedAt: timestamp('last_synced_at', { withTimezone: true })
	},
	(table) => [
		uniqueIndex('shipments_order_id_uq').on(table.orderId),
		// The cron sync selects in-flight rows by status.
		index('shipments_status_idx').on(table.status)
	]
);

export type ProductRow = typeof products.$inferSelect;
export type ProductStatus = ProductRow['status'];
export type OrderRow = typeof orders.$inferSelect;
export type OrderStatus = OrderRow['status'];
export type OrderItemRow = typeof orderItems.$inferSelect;
export type OrderEventRow = typeof orderEvents.$inferSelect;
export type ShipmentRow = typeof shipments.$inferSelect;
export type ShipmentStatus = ShipmentRow['status'];
