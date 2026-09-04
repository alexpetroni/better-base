import { sql } from 'drizzle-orm';
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
		/**
		 * VAT rate in basis points from the RO allowlist (`$lib/util/vat-rates`),
		 * e.g. 1100 for a reduced-rate food item; null = the STANDARD rate in
		 * force on the order date (`invoice.vatStandardRates`). Snapshotted onto
		 * `order_items` at checkout and from there onto the invoice lines
		 * (FIX-12).
		 */
		vatRateBp: integer('vat_rate_bp'),
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
	/** The company's seat (FIX-12) — the invoice's buyer address for B2B; absent = the parcel address is used. */
	address?: BuyerCompanyAddress;
}

export interface BuyerCompanyAddress {
	street: string;
	/** For București: `Sector n`. */
	city: string;
	/** ISO 3166-2:RO code. */
	county: string;
	postalCode: string;
}

/** Postal address as collected by Stripe Checkout (subset we care about). */
export interface ShippingAddress {
	name?: string;
	/**
	 * Recipient phone from Stripe's `customer_details` (Checkout collects it
	 * since FIX-11) — the courier refuses an AWB without one. Erased with the
	 * rest of the address by GDPR erasure.
	 */
	phone?: string;
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
		/**
		 * The PAYER's name (Stripe `customer_details.name`, FIX-12) — whom a
		 * B2C invoice names; the parcel recipient may differ. Erased with the
		 * address by GDPR erasure.
		 */
		customerName: text('customer_name').notNull().default(''),
		/**
		 * How the session was paid, for the invoice's payment means: `card`
		 * (the pinned default) or `online` (a session open to every method the
		 * dashboard enables); '' for orders created before FIX-12.
		 */
		paymentMethod: text('payment_method').notNull().default(''),
		/** Optional company details for a B2B invoice, as entered at checkout. */
		billingCompany: jsonb('billing_company').$type<BuyerCompany>(),
		/**
		 * Cumulative amount refunded by Stripe, in bani (`charge.amount_refunded`).
		 * A partial refund leaves `status` at `paid` and only moves this column;
		 * a full one flips the status too. Backfilled from the status by the
		 * migration (refunded → amount_total_cents).
		 */
		refundedCents: integer('refunded_cents').notNull().default(0),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('orders_created_at_idx').on(table.createdAt),
		// GDPR erase anonymizes by email; the refund webhook matches by intent.
		index('orders_email_idx').on(table.email),
		// Erase matches on lower(email): historical rows kept Stripe's casing.
		index('orders_email_lower_idx').on(sql`lower(${table.email})`),
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
		qty: integer('qty').notNull(),
		/**
		 * The product's VAT rate (bp) as it was at checkout; null = the standard
		 * rate on the order date. Issuance copies it to the invoice line, so a
		 * later product edit never changes what an order is invoiced at.
		 */
		vatRateBp: integer('vat_rate_bp')
	},
	(table) => [
		index('order_items_order_id_idx').on(table.orderId),
		index('order_items_product_id_idx').on(table.productId)
	]
);

/**
 * Courier shipments (AWBs) of an order, created by the admin "generate AWB"
 * action through the CourierProvider seam in two phases (FIX-11): a
 * `creating` claim row is committed first, the courier is called outside any
 * row lock, then the row becomes `registered` (awb, tracking) or `failed`
 * (last_error). ONE live row per order: the partial unique index excludes
 * `cancelled` and `failed`, so a courier-side cancellation or a refused AWB
 * can be followed by a replacement, while a double click can never register
 * two. `status` mirrors the courier's tracking state (normalized by the
 * adapter); the cron sync polls rows still in flight (`registered`/
 * `in-transit`) that are due (`next_sync_at`), backs a throwing row off
 * exponentially (`error_count`, `last_error`) and stops at a terminal state.
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
		/** The courier's AWB number; null while `creating` and on a `failed` claim. */
		awb: text('awb'),
		trackingUrl: text('tracking_url').notNull().default(''),
		status: text('status', {
			enum: ['creating', 'registered', 'in-transit', 'delivered', 'returned', 'cancelled', 'failed']
		})
			.notNull()
			.default('registered'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
		/** When the cron sync last polled this AWB; orders the per-run batch. */
		lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
		/**
		 * Earliest next poll after a tracking failure (exponential backoff);
		 * null = due whenever the batch reaches the row.
		 */
		nextSyncAt: timestamp('next_sync_at', { withTimezone: true }),
		/** Consecutive tracking failures; reset by the first successful poll. */
		errorCount: integer('error_count').notNull().default(0),
		/**
		 * Bounded text of the last failure: the courier's AWB refusal on a
		 * `failed` row, the last tracking error on an in-flight one.
		 */
		lastError: text('last_error')
	},
	(table) => [
		// One LIVE shipment per order — mirrors SHIPMENT_REPLACEABLE_STATUSES
		// in shipment-service.ts: a cancelled or failed row may be replaced.
		uniqueIndex('shipments_order_id_active_uq')
			.on(table.orderId)
			.where(sql`${table.status} not in ('cancelled', 'failed')`),
		index('shipments_order_id_idx').on(table.orderId),
		// The cron sync selects in-flight rows by status.
		index('shipments_status_idx').on(table.status)
	]
);

/**
 * Refunds whose order does not exist yet (audit 2026-09-03 P0 #3): Stripe
 * does not order deliveries, so `charge.refunded` can land before its
 * `checkout.session.completed` (rotated secret, bad deploy, retry backlog).
 * The refund handler records the charge here instead of dropping it, and
 * order creation consults the row for its payment intent — a full pending
 * refund creates the order already `refunded`, a partial one sets
 * `refunded_cents`. `matched_at` marks consumption; the retention sweep prunes
 * matched rows after the ledger window (unmatched ones stay for the operator).
 */
export const pendingRefunds = pgTable(
	'pending_refunds',
	{
		paymentIntent: text('payment_intent').primaryKey(),
		chargeId: text('charge_id').notNull(),
		/** The charge's total, in bani (`charge.amount`). */
		amountCents: integer('amount_cents').notNull(),
		/** Cumulative refunded amount, in bani (`charge.amount_refunded`). */
		amountRefundedCents: integer('amount_refunded_cents').notNull(),
		receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
		matchedAt: timestamp('matched_at', { withTimezone: true }),
		orderId: text('order_id').references(() => orders.id, { onDelete: 'set null' })
	},
	(table) => [index('pending_refunds_matched_at_idx').on(table.matchedAt)]
);

export type ProductRow = typeof products.$inferSelect;
export type ProductStatus = ProductRow['status'];
export type OrderRow = typeof orders.$inferSelect;
export type OrderStatus = OrderRow['status'];
export type OrderItemRow = typeof orderItems.$inferSelect;
export type OrderEventRow = typeof orderEvents.$inferSelect;
export type ShipmentRow = typeof shipments.$inferSelect;
export type ShipmentStatus = ShipmentRow['status'];
export type PendingRefundRow = typeof pendingRefunds.$inferSelect;
