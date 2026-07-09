import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp
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
		 * The payment claimed more units than were in stock (concurrent
		 * checkouts both passed the pre-payment stock check). Flagged by the
		 * webhook for manual follow-up — restock, partial refund, or apology.
		 */
		oversold: boolean('oversold').notNull().default(false),
		shippingAddress: jsonb('shipping_address').$type<ShippingAddress>(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('orders_created_at_idx').on(table.createdAt),
		// GDPR erase anonymizes by email; the refund webhook matches by intent.
		index('orders_email_idx').on(table.email),
		index('orders_stripe_payment_intent_idx').on(table.stripePaymentIntent)
	]
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

export type ProductRow = typeof products.$inferSelect;
export type ProductStatus = ProductRow['status'];
export type OrderRow = typeof orders.$inferSelect;
export type OrderStatus = OrderRow['status'];
export type OrderItemRow = typeof orderItems.$inferSelect;
