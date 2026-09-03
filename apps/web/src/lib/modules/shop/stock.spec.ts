import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import Stripe from 'stripe';
import { resolveSiteConfig } from '../../config/index.ts';
import { createDb, type Db } from '../../db/client.ts';
import { seedPillars } from '../../db/seed.ts';
import { createEmailSender } from '../email/service.ts';
import { settingsDefaults, validateSettingValue } from '../settings/registry.ts';
// Namespace import: the helper does not exist before the fix, and a named
// import would fail the whole file at load instead of this one test.
import * as cart from './cart.ts';
import { buildCartMetadata, createCheckoutFromCart, loadCartDetails } from './checkout.ts';
import { createMockStripeGateway } from './mock-gateway.ts';
import { products } from './schema.ts';
import { createProduct, updateProduct } from './service.ts';
import { shippingDisplayName } from './shipping.ts';
import { processStripeEvent, verifyStripeEvent, type WebhookDeps } from './webhook.ts';

// Stock, before and after payment (audit 2026-09-03 P1 "quantity is never
// compared with stock" and P2 "admin stock edit is an absolute write"):
// the cart must cap a line at what is in stock and checkout must refuse
// anything above it, and an operator's stock edit must not race the webhook
// decrement into a phantom unit. Plus the shipping-settings length cap.

const WEBHOOK_SECRET = 'whsec_stock_spec_secret';
const stripeSigner = new Stripe('sk_test_offline_signing_only');
const SLEEP_PILLARS = resolveSiteConfig('sleep').pillars;

let db: Db;
let webhookDeps: WebhookDeps;

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle')
	});
	await seedPillars(db, SLEEP_PILLARS);
	webhookDeps = {
		db,
		email: createEmailSender({ db, dryRun: true, from: 'test@example.ro' }),
		siteName: 'Better Sleep'
	};
});

afterAll(async () => {
	await db?.$client.end();
});

let seq = 0;

async function makeProduct(input: { name: string; stock: number | null; priceCents?: number }) {
	const created = await createProduct({ db }, { name: input.name });
	if (!created.ok) throw new Error('createProduct failed');
	const updated = await updateProduct({ db }, created.value.id, {
		priceCents: input.priceCents ?? 4990,
		status: 'active',
		pillarSlugs: ['somn'],
		stock: input.stock
	});
	if (!updated.ok) throw new Error(`updateProduct failed: ${updated.error}`);
	return updated.value;
}

async function stockOf(productId: string): Promise<number | null> {
	const [row] = await db.select().from(products).where(eq(products.id, productId));
	return row.stock;
}

/** A paid webhook for `qty` units of the product — the decrement the admin races. */
async function paidWebhook(productId: string, qty: number) {
	seq += 1;
	const payload = JSON.stringify({
		id: `evt_stock_${seq}`,
		object: 'event',
		type: 'checkout.session.completed',
		data: {
			object: {
				id: `cs_stock_${seq}`,
				object: 'checkout.session',
				amount_total: qty * 4990,
				currency: 'ron',
				payment_intent: `pi_stock_${seq}`,
				payment_status: 'paid',
				customer_details: { email: `stock-${seq}@example.ro`, name: 'Ana Pop' },
				metadata: { cart: buildCartMetadata([{ productId, qty, priceCents: 4990 }]) }
			}
		}
	});
	const event = await verifyStripeEvent(
		payload,
		stripeSigner.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
		WEBHOOK_SECRET
	);
	const outcome = await processStripeEvent(webhookDeps, event);
	if (outcome.kind !== 'order-created') throw new Error(`unexpected outcome ${outcome.kind}`);
}

describe('quantity vs stock (audit P1)', () => {
	it('stock 1, qty 5: the line is unavailable with maxQty 1, and checkout refuses naming the available count', async () => {
		const scarce = await makeProduct({ name: 'Ultima pernă', stock: 1 });
		const plenty = await makeProduct({ name: 'Pernă din belșug', stock: 3 });
		const untracked = await makeProduct({ name: 'Ceai neurmărit', stock: null });

		const details = await loadCartDetails(
			{ db },
			[
				{ productId: scarce.id, qty: 5 },
				{ productId: plenty.id, qty: 3 },
				{ productId: untracked.id, qty: 99 }
			],
			SLEEP_PILLARS
		);
		expect(details.lines.map((l) => [l.available, l.maxQty])).toEqual([
			[false, 1],
			[true, 3],
			[true, null]
		]);
		// The total counts only what can actually be sold.
		expect(details.totalCents).toBe(3 * 4990 + 99 * 4990);

		const outcome = await createCheckoutFromCart(
			{ db, gateway: createMockStripeGateway(), baseUrl: 'https://example.ro' },
			{
				items: [
					{ productId: scarce.id, qty: 5 },
					{ productId: plenty.id, qty: 3 }
				],
				sitePillarSlugs: SLEEP_PILLARS,
				shippingSettings: settingsDefaults(),
				shippingOptionId: 'standard'
			}
		);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error).toBe('unavailable');
		expect(outcome.detail).toContain('Ultima pernă');
		expect(outcome.detail).toContain('1');
		expect(outcome.detail).not.toContain('belșug');
		// Nothing was reserved or charged by the refusal.
		expect(await stockOf(scarce.id)).toBe(1);
	});

	it('exactly the stock is still purchasable; zero stock stays out of stock', async () => {
		const two = await makeProduct({ name: 'Două bucăți', stock: 2 });
		const none = await makeProduct({ name: 'Zero bucăți', stock: 0 });
		const details = await loadCartDetails(
			{ db },
			[
				{ productId: two.id, qty: 2 },
				{ productId: none.id, qty: 1 }
			],
			SLEEP_PILLARS
		);
		expect(details.lines.map((l) => [l.available, l.maxQty])).toEqual([
			[true, 2],
			[false, 0]
		]);
	});

	it('clampLineToStock (pure): caps a line at the tracked stock, leaves untracked lines alone, never below one unit', () => {
		const lines = [
			{ productId: 'a', qty: 5 },
			{ productId: 'b', qty: 5 }
		];
		expect(cart.clampLineToStock(lines, 'a', 2)).toEqual([
			{ productId: 'a', qty: 2 },
			{ productId: 'b', qty: 5 }
		]);
		expect(cart.clampLineToStock(lines, 'a', null)).toEqual(lines);
		expect(cart.clampLineToStock(lines, 'a', 9)).toEqual(lines);
		// Zero stock keeps the line (flagged unavailable on the page) at one unit
		// rather than silently deleting the customer's choice.
		expect(cart.clampLineToStock(lines, 'b', 0)[1]).toEqual({ productId: 'b', qty: 1 });
		expect(cart.clampLineToStock(lines, 'missing', 1)).toEqual(lines);
	});
});

describe('stock edits vs the webhook decrement (audit P2)', () => {
	it('an absolute save with a stale expected value is refused (stock-changed) and writes nothing — no phantom unit', async () => {
		const product = await makeProduct({ name: 'Editare veche', stock: 5 });
		// The operator loaded the form at 5; a sale lands before they save.
		await paidWebhook(product.id, 2);
		expect(await stockOf(product.id)).toBe(3);

		const result = await updateProduct({ db }, product.id, {
			name: 'Editare veche (redenumit)',
			stock: 6,
			expectedStock: 5
		});
		expect(result).toEqual({ ok: false, error: 'stock-changed', detail: '3' });
		expect(await stockOf(product.id)).toBe(3);
		// The whole save is refused, not just the stock column.
		const [row] = await db.select().from(products).where(eq(products.id, product.id));
		expect(row.name).toBe('Editare veche');

		// With the current value as the expectation the save goes through.
		const fresh = await updateProduct({ db }, product.id, { stock: 6, expectedStock: 3 });
		expect(fresh.ok && fresh.value.stock).toBe(6);
	});

	it('racing: an absolute save concurrent with the webhook decrement never yields a phantom unit', async () => {
		const product = await makeProduct({ name: 'Cursă absolută', stock: 5 });
		const [, save] = await Promise.all([
			paidWebhook(product.id, 2),
			updateProduct({ db }, product.id, { stock: 5, expectedStock: 5 })
		]);
		// Either the save landed first (a no-op at 5) and the sale took it to
		// 3, or the sale landed first and the stale save was refused. Both
		// end at 3 — the sold units can never reappear.
		if (!save.ok) expect(save.error).toBe('stock-changed');
		expect(await stockOf(product.id)).toBe(3);
	});

	it('a relative restock adds exactly N, even concurrently with a sale', async () => {
		const product = await makeProduct({ name: 'Restoc', stock: 5 });
		const [, restock] = await Promise.all([
			paidWebhook(product.id, 2),
			updateProduct({ db }, product.id, { stockDelta: 10 })
		]);
		expect(restock.ok).toBe(true);
		expect(await stockOf(product.id)).toBe(13);
	});

	it('a relative restock is refused on untracked stock and for a non-positive delta', async () => {
		const untracked = await makeProduct({ name: 'Restoc neurmărit', stock: null });
		expect(await updateProduct({ db }, untracked.id, { stockDelta: 3 })).toMatchObject({
			ok: false,
			error: 'invalid-stock'
		});
		expect(await stockOf(untracked.id)).toBeNull();
		const tracked = await makeProduct({ name: 'Restoc zero', stock: 4 });
		expect(await updateProduct({ db }, tracked.id, { stockDelta: 0 })).toMatchObject({
			ok: false,
			error: 'invalid-stock'
		});
		expect(await updateProduct({ db }, tracked.id, { stockDelta: -1 })).toMatchObject({
			ok: false,
			error: 'invalid-stock'
		});
		expect(await stockOf(tracked.id)).toBe(4);
	});
});

describe('shipping settings length (audit P2 — Stripe caps display names at 100 chars)', () => {
	it('display names are capped at 60 and ETAs at 40 characters', () => {
		expect(validateSettingValue('shop.shippingStandardName', 'x'.repeat(60))).toBeNull();
		expect(validateSettingValue('shop.shippingStandardName', 'x'.repeat(61))).toBe('too-long');
		expect(validateSettingValue('shop.shippingExpressName', 'x'.repeat(61))).toBe('too-long');
		expect(validateSettingValue('shop.shippingStandardEta', 'y'.repeat(40))).toBeNull();
		expect(validateSettingValue('shop.shippingStandardEta', 'y'.repeat(41))).toBe('too-long');
		expect(validateSettingValue('shop.shippingExpressEta', 'y'.repeat(41))).toBe('too-long');
	});

	it('what reaches Stripe never exceeds 100 characters, even at both caps', () => {
		const name = shippingDisplayName({ name: 'x'.repeat(60), etaText: 'y'.repeat(40) });
		expect(name.length).toBeLessThanOrEqual(100);
		expect(name.startsWith('x'.repeat(60))).toBe(true);
	});
});
