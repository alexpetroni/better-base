import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import Stripe from 'stripe';
import { withDbFault } from '../../../../tests/helpers/db-fault.ts';
import { resolveSiteConfig } from '../../config/index.ts';
import { createDb, type Db } from '../../db/client.ts';
import { pillars } from '../../db/schema/core.ts';
import { seedPillars } from '../../db/seed.ts';
import { processedEvents } from '../../server/event-ledger/schema.ts';
import { emailLog } from '../email/schema.ts';
import { settingsDefaults } from '../settings/registry.ts';
import { createEmailSender, type EmailSender } from '../email/service.ts';
import { media } from '../media/schema.ts';
import {
	buildCartMetadata,
	createCheckoutFromCart,
	loadCartDetails,
	parseCartMetadata
} from './checkout.ts';
import { productsMediaReferenceCheck } from './media-ref.ts';
import { createMockStripeGateway, type MockStripeGateway } from './mock-gateway.ts';
import { orderEvents, orderItems, orders, productPillars, products } from './schema.ts';
import {
	createProduct,
	getProductBySlug,
	isOutOfStock,
	listVisibleProducts,
	updateProduct,
	type ShopDeps
} from './service.ts';
import { syncProductToStripe } from './sync.ts';
import { processStripeEvent, verifyStripeEvent, type WebhookDeps } from './webhook.ts';

// Integration against the compose Postgres (TEST_DATABASE_URL, re-migrated
// fresh). Stripe is ALWAYS the in-memory mock here; webhook signatures are
// produced with the SDK's offline test helper — no network anywhere.

const WEBHOOK_SECRET = 'whsec_shop_spec_secret';
// Constructed only for its offline webhook signing helper.
const stripeSigner = new Stripe('sk_test_offline_signing_only');

const SLEEP_PILLARS = resolveSiteConfig('sleep').pillars;
const LIFE_PILLARS = resolveSiteConfig('life').pillars;

let db: Db;
let deps: ShopDeps;
let email: EmailSender;
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
	await seedPillars(db, LIFE_PILLARS); // all 9, so both site configs can be exercised
	deps = { db };
	email = createEmailSender({ db, dryRun: true, from: 'test@example.ro' });
	webhookDeps = { db, email, siteName: 'Better Sleep' };
});

afterAll(async () => {
	await db?.$client.end();
});

async function makeProduct(input: {
	name: string;
	priceCents?: number;
	status?: 'draft' | 'active' | 'archived';
	pillarSlugs?: string[];
	stock?: number | null;
}) {
	const created = await createProduct(deps, { name: input.name });
	if (!created.ok) throw new Error('createProduct failed');
	const updated = await updateProduct(deps, created.value.id, {
		priceCents: input.priceCents ?? 4990,
		status: input.status ?? 'active',
		pillarSlugs: input.pillarSlugs ?? ['somn'],
		stock: input.stock === undefined ? null : input.stock
	});
	if (!updated.ok) throw new Error(`updateProduct failed: ${updated.error}`);
	return updated.value;
}

describe('product CRUD', () => {
	it('creates with a unique ro slug and dedupes collisions', async () => {
		const first = await createProduct(deps, { name: 'Pernă ergonomică' });
		expect(first.ok && first.value.slug).toBe('perna-ergonomica');
		const second = await createProduct(deps, { name: 'Pernă ergonomică' });
		expect(second.ok && second.value.slug).toBe('perna-ergonomica-2');
	});

	it('validates patches: price and stock must be non-negative integers', async () => {
		const row = await makeProduct({ name: 'Validare' });
		expect((await updateProduct(deps, row.id, { priceCents: 12.5 })).ok).toBe(false);
		expect((await updateProduct(deps, row.id, { priceCents: -1 })).ok).toBe(false);
		expect((await updateProduct(deps, row.id, { stock: -2 })).ok).toBe(false);
		expect((await updateProduct(deps, row.id, { pillarSlugs: ['nope'] })).ok).toBe(false);
		const ok = await updateProduct(deps, row.id, { priceCents: 12345, stock: null });
		expect(ok.ok && ok.value.priceCents).toBe(12345);
	});

	it('validates the per-product VAT rate against the RO allowlist; null means the standard rate', async () => {
		const row = await makeProduct({ name: 'Cotă TVA' });
		// Not a legal RO rate, a percent instead of basis points, and zero
		// (category Z by accident) are all refused.
		expect((await updateProduct(deps, row.id, { vatRateBp: 2200 })).ok).toBe(false);
		expect((await updateProduct(deps, row.id, { vatRateBp: 21 })).ok).toBe(false);
		expect((await updateProduct(deps, row.id, { vatRateBp: 0 })).ok).toBe(false);
		const reduced = await updateProduct(deps, row.id, { vatRateBp: 1100 });
		expect(reduced.ok && reduced.value.vatRateBp).toBe(1100);
		const standard = await updateProduct(deps, row.id, { vatRateBp: null });
		expect(standard.ok && standard.value.vatRateBp).toBeNull();
	});

	it('retagging is atomic: a failed re-insert keeps the old pillar tags (audit Theme B)', async () => {
		const row = await makeProduct({ name: 'Retag atomic', pillarSlugs: ['somn'] });
		const [somn] = await db.select().from(pillars).where(eq(pillars.slug, 'somn'));

		const { db: faultyDb, fault } = withDbFault(db, 'insert', productPillars);
		fault.arm();
		await expect(
			updateProduct({ db: faultyDb }, row.id, { pillarSlugs: ['nutritie'] })
		).rejects.toThrow('injected insert fault');
		expect(fault.hits).toBe(1);

		// The delete must have rolled back with the failed insert — otherwise the
		// product silently loses all tags and disappears from every site.
		const joins = await db
			.select()
			.from(productPillars)
			.where(eq(productPillars.productId, row.id));
		expect(joins.map((j) => j.pillarId)).toEqual([somn.id]);
	});
});

describe('products media reference check (audit data HIGH-3)', () => {
	async function insertImage(id: string, key: string) {
		await db.insert(media).values({
			id,
			kind: 'image',
			key,
			filename: path.basename(key),
			mime: 'image/png',
			size: 123
		});
	}

	it('claims covers, gallery entries and markdown description refs; frees the rest', async () => {
		await insertImage('pm-cover', 'uploads/p/cover.png');
		await insertImage('pm-gallery', 'uploads/p/gallery.png');
		await insertImage('pm-desc-id', 'uploads/p/desc-id.png');
		await insertImage('pm-desc-key', 'uploads/p/desc-key.png');
		await insertImage('pm-free', 'uploads/p/free.png');

		const row = await makeProduct({ name: 'Produs cu media' });
		await updateProduct(deps, row.id, {
			coverMediaId: 'pm-cover',
			gallery: ['pm-gallery'],
			descriptionMd: 'detalii ![a](media:pm-desc-id) și ![b](media:uploads/p/desc-key.png)'
		});

		expect(await productsMediaReferenceCheck.isReferenced(db, 'pm-cover')).toBe(true);
		expect(await productsMediaReferenceCheck.isReferenced(db, 'pm-gallery')).toBe(true);
		// The description refs dangled before FIX-5 — the check only saw cover + gallery.
		expect(await productsMediaReferenceCheck.isReferenced(db, 'pm-desc-id')).toBe(true);
		expect(await productsMediaReferenceCheck.isReferenced(db, 'pm-desc-key')).toBe(true);
		expect(await productsMediaReferenceCheck.isReferenced(db, 'pm-free')).toBe(false);
	});
});

describe('public visibility (active + tagged to a site pillar)', () => {
	it('applies the same rule as blog/quiz on BOTH site configs', async () => {
		const somnProduct = await makeProduct({ name: 'Vizibil somn', pillarSlugs: ['somn'] });
		const nutritieProduct = await makeProduct({
			name: 'Vizibil nutriție',
			pillarSlugs: ['nutritie']
		});
		const untagged = await makeProduct({ name: 'Fără pilon', pillarSlugs: [] });
		const draft = await makeProduct({ name: 'Ciornă somn', status: 'draft' });
		const archived = await makeProduct({ name: 'Arhivat somn', status: 'archived' });

		const onSleep = (await listVisibleProducts(deps, { pillarSlugs: SLEEP_PILLARS })).map(
			(i) => i.product.id
		);
		const onLife = (await listVisibleProducts(deps, { pillarSlugs: LIFE_PILLARS })).map(
			(i) => i.product.id
		);

		// somn-tagged: visible on both sites.
		expect(onSleep).toContain(somnProduct.id);
		expect(onLife).toContain(somnProduct.id);
		// nutritie-tagged: hidden on better-sleep, visible on better-life —
		// the "products tagged to inactive pillars are excluded per site" DoD case.
		expect(onSleep).not.toContain(nutritieProduct.id);
		expect(onLife).toContain(nutritieProduct.id);
		// untagged / draft / archived: visible nowhere.
		for (const hidden of [untagged.id, draft.id, archived.id]) {
			expect(onSleep).not.toContain(hidden);
			expect(onLife).not.toContain(hidden);
		}
	});

	it('getProductBySlug hides non-active and foreign-pillar products unless includeHidden', async () => {
		const draft = await makeProduct({ name: 'Slug ciornă', status: 'draft' });
		expect(await getProductBySlug(deps, draft.slug, { sitePillarSlugs: SLEEP_PILLARS })).toBeNull();
		const admin = await getProductBySlug(deps, draft.slug, {
			sitePillarSlugs: SLEEP_PILLARS,
			includeHidden: true
		});
		expect(admin?.product.id).toBe(draft.id);

		const foreign = await makeProduct({ name: 'Slug nutriție', pillarSlugs: ['nutritie'] });
		expect(
			await getProductBySlug(deps, foreign.slug, { sitePillarSlugs: SLEEP_PILLARS })
		).toBeNull();
		const onLife = await getProductBySlug(deps, foreign.slug, { sitePillarSlugs: LIFE_PILLARS });
		expect(onLife?.product.id).toBe(foreign.id);
	});

	it('tracked zero stock is out of stock but still listed', async () => {
		const out = await makeProduct({ name: 'Epuizat', stock: 0 });
		expect(isOutOfStock(out)).toBe(true);
		const listed = await listVisibleProducts(deps, { pillarSlugs: SLEEP_PILLARS });
		expect(listed.some((i) => i.product.id === out.id)).toBe(true);
	});
});

describe('Stripe sync (mock gateway)', () => {
	it('creates product + price once, then only refreshes the product', async () => {
		const gateway = createMockStripeGateway();
		const row = await makeProduct({ name: 'Sincronizat', priceCents: 5000 });

		const first = await syncProductToStripe({ db, gateway }, row.id);
		expect(first.ok && first.priceChanged).toBe(true);
		if (!first.ok) return;
		expect(first.product.stripeProductId).toMatch(/^prod_mock_/);
		expect(first.product.stripePriceId).toMatch(/^price_mock_/);

		const second = await syncProductToStripe({ db, gateway }, row.id);
		expect(second.ok && second.priceChanged).toBe(false);
		if (!second.ok) return;
		expect(second.product.stripePriceId).toBe(first.product.stripePriceId);
		expect(gateway.archivedPrices.size).toBe(0);
	});

	it('a price change creates a new Stripe price and archives the old one', async () => {
		const gateway = createMockStripeGateway();
		const row = await makeProduct({ name: 'Preț schimbat', priceCents: 5000 });
		const first = await syncProductToStripe({ db, gateway }, row.id);
		if (!first.ok) throw new Error('first sync failed');
		const oldPriceId = first.product.stripePriceId!;

		await updateProduct(deps, row.id, { priceCents: 7500 });
		const resynced = await syncProductToStripe({ db, gateway }, row.id);
		expect(resynced.ok && resynced.priceChanged).toBe(true);
		if (!resynced.ok) return;
		expect(resynced.product.stripePriceId).not.toBe(oldPriceId);
		expect(gateway.archivedPrices.has(oldPriceId)).toBe(true);
		expect(gateway.prices.get(resynced.product.stripePriceId!)?.unitAmountCents).toBe(7500);
	});

	it('an unpriced product syncs without creating a price', async () => {
		const gateway = createMockStripeGateway();
		const row = await makeProduct({ name: 'Fără preț', priceCents: 0 });
		const synced = await syncProductToStripe({ db, gateway }, row.id);
		expect(synced.ok && synced.product.stripeProductId).toMatch(/^prod_mock_/);
		expect(synced.ok && synced.product.stripePriceId).toBeNull();
	});
});

describe('cart details and checkout session', () => {
	let gateway: MockStripeGateway;

	beforeAll(() => {
		gateway = createMockStripeGateway();
	});

	it('loadCartDetails computes integer-cent totals and flags unavailable lines', async () => {
		const a = await makeProduct({ name: 'Coș A', priceCents: 4990 });
		const b = await makeProduct({ name: 'Coș B', priceCents: 12550 });
		const out = await makeProduct({ name: 'Coș epuizat', stock: 0 });

		const details = await loadCartDetails(
			{ db },
			[
				{ productId: a.id, qty: 2 },
				{ productId: b.id, qty: 1 },
				{ productId: out.id, qty: 1 },
				{ productId: 'missing-product', qty: 3 }
			],
			SLEEP_PILLARS
		);

		// The missing product is dropped; the out-of-stock one is kept but flagged.
		expect(details.lines).toHaveLength(3);
		expect(details.lines.map((l) => l.available)).toEqual([true, true, false]);
		expect(details.lines[0].lineTotalCents).toBe(9980);
		// The total only counts available lines.
		expect(details.totalCents).toBe(22530);
	});

	it('creates a checkout session with the paid snapshot in metadata', async () => {
		const a = await makeProduct({ name: 'Checkout A', priceCents: 4990 });
		const b = await makeProduct({ name: 'Checkout B', priceCents: 12550 });

		const outcome = await createCheckoutFromCart(
			{ db, gateway, baseUrl: 'https://example.ro' },
			{
				items: [
					{ productId: a.id, qty: 2 },
					{ productId: b.id, qty: 1 }
				],
				sitePillarSlugs: SLEEP_PILLARS,
				shippingSettings: settingsDefaults(),
				shippingOptionId: 'standard'
			}
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.url).toContain(outcome.sessionId);

		const session = gateway.sessions.get(outcome.sessionId)!;
		expect(session.amountTotalCents).toBe(22530);
		expect(session.input.successUrl).toBe(
			'https://example.ro/cos/succes?session_id={CHECKOUT_SESSION_ID}'
		);
		expect(session.input.cancelUrl).toBe('https://example.ro/cos');
		expect(session.input.shippingCountries).toEqual(['RO']);
		expect(session.input.lineItems.every((li) => li.currency === 'ron')).toBe(true);
		expect(session.metadata.cart).toBe(
			buildCartMetadata([
				{ productId: a.id, qty: 2, priceCents: 4990 },
				{ productId: b.id, qty: 1, priceCents: 12550 }
			])
		);
	});

	it('the cart snapshot carries each product VAT rate, so the order items inherit it (FIX-12)', async () => {
		const standard = await makeProduct({ name: 'Checkout TVA standard', priceCents: 4990 });
		const reduced = await makeProduct({ name: 'Checkout TVA redusă', priceCents: 1150 });
		expect((await updateProduct(deps, reduced.id, { vatRateBp: 1100 })).ok).toBe(true);

		const outcome = await createCheckoutFromCart(
			{ db, gateway, baseUrl: 'https://example.ro' },
			{
				items: [
					{ productId: standard.id, qty: 1 },
					{ productId: reduced.id, qty: 2 }
				],
				sitePillarSlugs: SLEEP_PILLARS,
				shippingSettings: settingsDefaults(),
				shippingOptionId: 'standard'
			}
		);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const session = gateway.sessions.get(outcome.sessionId)!;
		expect(parseCartMetadata(session.metadata.cart)).toEqual([
			{ i: standard.id, q: 1, p: 4990 },
			{ i: reduced.id, q: 2, p: 1150, v: 1100 }
		]);

		// Through the webhook, the rate lands on the order items (null = standard).
		const payload = completedSessionEvent({
			id: 'cs_vat_snapshot',
			cart: [
				{ productId: standard.id, qty: 1, priceCents: 4990 },
				{ productId: reduced.id, qty: 2, priceCents: 1150, vatRateBp: 1100 }
			],
			amountTotal: 7290
		});
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);
		const created = await processStripeEvent(webhookDeps, event);
		if (created.kind !== 'order-created') throw new Error(`unexpected ${created.kind}`);
		const items = await db.select().from(orderItems).where(eq(orderItems.orderId, created.orderId));
		expect(
			items.map((item) => [item.productId, item.vatRateBp]).sort((x, y) => (x[0]! < y[0]! ? -1 : 1))
		).toEqual(
			[
				[standard.id, null],
				[reduced.id, 1100]
			].sort((x, y) => (x[0]! < y[0]! ? -1 : 1))
		);
	});

	it('refuses an empty cart and carts with unavailable products', async () => {
		const empty = await createCheckoutFromCart(
			{ db, gateway, baseUrl: 'https://example.ro' },
			{
				items: [],
				sitePillarSlugs: SLEEP_PILLARS,
				shippingSettings: settingsDefaults(),
				shippingOptionId: 'standard'
			}
		);
		expect(!empty.ok && empty.error).toBe('empty-cart');

		const out = await makeProduct({ name: 'Checkout epuizat', stock: 0 });
		const unavailable = await createCheckoutFromCart(
			{ db, gateway, baseUrl: 'https://example.ro' },
			{
				items: [{ productId: out.id, qty: 1 }],
				sitePillarSlugs: SLEEP_PILLARS,
				shippingSettings: settingsDefaults(),
				shippingOptionId: 'standard'
			}
		);
		expect(!unavailable.ok && unavailable.error).toBe('unavailable');
		expect(!unavailable.ok && unavailable.detail).toContain('Checkout epuizat');
	});
});

interface SessionOverrides {
	id: string;
	cart: Array<{ productId: string; qty: number; priceCents: number; vatRateBp?: number | null }>;
	amountTotal: number;
	paymentIntent?: string;
	email?: string;
	/** Stripe `customer_details.phone` (collected by Checkout since FIX-11). */
	phone?: string;
	/** Provider event id; defaults to one derived from the session id. */
	eventId?: string;
}

function completedSessionEvent(overrides: SessionOverrides): string {
	return JSON.stringify({
		id: overrides.eventId ?? `evt_${overrides.id}`,
		object: 'event',
		type: 'checkout.session.completed',
		api_version: '2026-01-01',
		created: 1783000000,
		data: {
			object: {
				id: overrides.id,
				object: 'checkout.session',
				amount_total: overrides.amountTotal,
				currency: 'ron',
				payment_intent: overrides.paymentIntent ?? 'pi_test_1',
				payment_status: 'paid',
				customer_details: {
					email: overrides.email ?? 'client@example.ro',
					name: 'Ana Pop',
					...(overrides.phone ? { phone: overrides.phone } : {})
				},
				collected_information: {
					shipping_details: {
						name: 'Ana Pop',
						address: {
							line1: 'Str. Somnului 10',
							city: 'Cluj-Napoca',
							postal_code: '400001',
							country: 'RO'
						}
					}
				},
				metadata: { cart: buildCartMetadata(overrides.cart) }
			}
		}
	});
}

function signedHeader(payload: string, secret = WEBHOOK_SECRET): string {
	return stripeSigner.webhooks.generateTestHeaderString({ payload, secret });
}

describe('webhook: signature verification', () => {
	it('accepts a correctly signed payload', async () => {
		const payload = completedSessionEvent({ id: 'cs_sig_ok', cart: [], amountTotal: 0 });
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);
		expect(event.type).toBe('checkout.session.completed');
	});

	it('rejects tampered payloads and foreign secrets', async () => {
		const payload = completedSessionEvent({ id: 'cs_sig_bad', cart: [], amountTotal: 0 });
		const header = signedHeader(payload);
		const tampered = payload.replace('"amount_total":0', '"amount_total":1');
		await expect(verifyStripeEvent(tampered, header, WEBHOOK_SECRET)).rejects.toThrow();
		await expect(
			verifyStripeEvent(payload, signedHeader(payload, 'whsec_other'), WEBHOOK_SECRET)
		).rejects.toThrow();
	});
});

describe('webhook: checkout.session.completed', () => {
	it('stores the order email lowercased, however Stripe delivers it (GDPR erase match)', async () => {
		const product = await makeProduct({ name: 'Comandă mixed-case', priceCents: 4990 });
		const payload = completedSessionEvent({
			id: 'cs_mixed_email',
			cart: [{ productId: product.id, qty: 1, priceCents: 4990 }],
			amountTotal: 4990,
			email: 'Ion.Popescu@Gmail.com'
		});
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);
		const outcome = await processStripeEvent(webhookDeps, event);
		expect(outcome.kind).toBe('order-created');
		if (outcome.kind !== 'order-created') return;
		const [order] = await db.select().from(orders).where(eq(orders.id, outcome.orderId));
		expect(order.email).toBe('ion.popescu@gmail.com');
	});

	it('persists the recipient phone from customer_details into the shipping address', async () => {
		const product = await makeProduct({ name: 'Comandă cu telefon', priceCents: 1000 });
		const payload = completedSessionEvent({
			id: 'cs_phone',
			cart: [{ productId: product.id, qty: 1, priceCents: 1000 }],
			amountTotal: 1000,
			phone: '+40 723 000 111'
		});
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);
		const outcome = await processStripeEvent(webhookDeps, event);
		if (outcome.kind !== 'order-created') throw new Error(`unexpected ${outcome.kind}`);
		const [order] = await db.select().from(orders).where(eq(orders.id, outcome.orderId));
		expect(order.shippingAddress?.phone).toBe('+40 723 000 111');
		expect(order.shippingAddress?.city).toBe('Cluj-Napoca');
	});

	it('creates the order + item snapshots, decrements stock and logs ONE email', async () => {
		const tracked = await makeProduct({ name: 'Comandă urmărită', priceCents: 4990, stock: 5 });
		const untracked = await makeProduct({ name: 'Comandă neurmărită', priceCents: 12550 });
		const cart = [
			{ productId: tracked.id, qty: 2, priceCents: 4990 },
			{ productId: untracked.id, qty: 1, priceCents: 12550 }
		];
		const payload = completedSessionEvent({ id: 'cs_happy', cart, amountTotal: 22530 });
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);

		const outcome = await processStripeEvent(webhookDeps, event);
		expect(outcome.kind).toBe('order-created');
		if (outcome.kind !== 'order-created') return;

		const [order] = await db.select().from(orders).where(eq(orders.id, outcome.orderId));
		expect(order.stripeSessionId).toBe('cs_happy');
		expect(order.email).toBe('client@example.ro');
		expect(order.amountTotalCents).toBe(22530);
		expect(order.status).toBe('paid');
		// Fulfillment starts at the head of the state machine; only
		// transitionFulfillment moves it from here.
		expect(order.fulfillmentStatus).toBe('unfulfilled');
		expect(order.shippingAddress?.city).toBe('Cluj-Napoca');
		expect(order.shippingAddress?.postalCode).toBe('400001');

		// The audit trail opens with the creation event, committed with the
		// order — plus the recorded invoice failure: this spec's database has
		// no issuer settings, and a paid order whose invoice cannot be issued
		// must say so on its trail instead of failing the order (NEXT-6).
		const trail = await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id));
		expect(trail.map((e) => e.kind).sort()).toEqual(['created', 'invoice-failed']);
		expect(trail.find((e) => e.kind === 'created')).toMatchObject({
			actor: 'stripe-webhook',
			note: 'cs_happy'
		});
		expect(trail.find((e) => e.kind === 'invoice-failed')?.note).toContain('settings-incomplete');

		// And the ledger recorded what this event did.
		const [ledger] = await db
			.select()
			.from(processedEvents)
			.where(eq(processedEvents.eventId, 'evt_cs_happy'));
		expect(ledger).toMatchObject({
			provider: 'stripe',
			eventType: 'checkout.session.completed',
			outcome: 'order-created'
		});

		const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
		expect(items).toHaveLength(2);
		const trackedItem = items.find((i) => i.productId === tracked.id)!;
		expect(trackedItem.name).toBe('Comandă urmărită');
		expect(trackedItem.priceCents).toBe(4990);
		expect(trackedItem.qty).toBe(2);

		// Tracked stock decremented; untracked left null.
		const [afterTracked] = await db.select().from(products).where(eq(products.id, tracked.id));
		expect(afterTracked.stock).toBe(3);
		const [afterUntracked] = await db.select().from(products).where(eq(products.id, untracked.id));
		expect(afterUntracked.stock).toBeNull();

		// Exactly one order-confirmation email, dry-run, keyed on the order id.
		const logs = await db
			.select()
			.from(emailLog)
			.where(eq(emailLog.idempotencyKey, `order-confirmation:${order.id}`));
		expect(logs).toHaveLength(1);
		expect(logs[0].status).toBe('dryrun');
		expect(logs[0].toEmail).toBe('client@example.ro');
	});

	it('is idempotent: a duplicate delivery yields exactly one order and one email', async () => {
		const product = await makeProduct({ name: 'Duplicat', priceCents: 1000, stock: 10 });
		const cart = [{ productId: product.id, qty: 1, priceCents: 1000 }];
		const payload = completedSessionEvent({ id: 'cs_duplicate', cart, amountTotal: 1000 });
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);

		const first = await processStripeEvent(webhookDeps, event);
		expect(first.kind).toBe('order-created');
		// Same event id again: the ledger reports the hit and what the first
		// delivery did, so the operator can see why nothing changed.
		const second = await processStripeEvent(webhookDeps, event);
		expect(second).toEqual({
			kind: 'duplicate-event',
			eventId: 'evt_cs_duplicate',
			firstOutcome: 'order-created'
		});

		const rows = await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_duplicate'));
		expect(rows).toHaveLength(1);
		const items = await db.select().from(orderItems).where(eq(orderItems.orderId, rows[0].id));
		expect(items).toHaveLength(1);
		// Stock decremented ONCE, email logged ONCE.
		const [after] = await db.select().from(products).where(eq(products.id, product.id));
		expect(after.stock).toBe(9);
		const logs = await db
			.select()
			.from(emailLog)
			.where(eq(emailLog.idempotencyKey, `order-confirmation:${rows[0].id}`));
		expect(logs).toHaveLength(1);
	});

	it('floors tracked stock at zero AND flags the order oversold (audit resilience #7)', async () => {
		const scarce = await makeProduct({ name: 'Stoc mic', priceCents: 2000, stock: 1 });
		const cart = [{ productId: scarce.id, qty: 3, priceCents: 2000 }];
		const payload = completedSessionEvent({ id: 'cs_floor', cart, amountTotal: 6000 });
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);
		await processStripeEvent(webhookDeps, event);

		const [after] = await db.select().from(products).where(eq(products.id, scarce.id));
		expect(after.stock).toBe(0);
		const [order] = await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_floor'));
		expect(order.oversold).toBe(true);
	});

	it('two paid checkouts racing for the last unit: the second order is flagged, exact sell-out is not', async () => {
		// Both buyers passed the pre-payment stock check with stock 1; payment
		// happens outside our control, so both webhooks arrive "paid".
		const last = await makeProduct({ name: 'Ultima bucată', priceCents: 2000, stock: 1 });
		const cart = [{ productId: last.id, qty: 1, priceCents: 2000 }];
		for (const sessionId of ['cs_race_first', 'cs_race_second']) {
			const payload = completedSessionEvent({ id: sessionId, cart, amountTotal: 2000 });
			const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);
			expect((await processStripeEvent(webhookDeps, event)).kind).toBe('order-created');
		}

		const [first] = await db
			.select()
			.from(orders)
			.where(eq(orders.stripeSessionId, 'cs_race_first'));
		const [second] = await db
			.select()
			.from(orders)
			.where(eq(orders.stripeSessionId, 'cs_race_second'));
		// The first buyer got the unit (exact sell-out — not oversold);
		// the second paid for a unit that no longer existed.
		expect(first.oversold).toBe(false);
		expect(second.oversold).toBe(true);
		const [after] = await db.select().from(products).where(eq(products.id, last.id));
		expect(after.stock).toBe(0);
	});

	it('acknowledges unknown event types without side effects', async () => {
		const payload = JSON.stringify({
			id: 'evt_other',
			object: 'event',
			type: 'payment_intent.created',
			data: { object: { id: 'pi_x', object: 'payment_intent' } }
		});
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);
		const outcome = await processStripeEvent(webhookDeps, event);
		expect(outcome).toEqual({ kind: 'ignored', type: 'payment_intent.created' });
	});
});

describe('webhook: atomicity — a partial failure commits nothing (audit Theme B)', () => {
	it('rolls back everything when the items insert fails; redelivery then creates the complete order exactly once', async () => {
		const product = await makeProduct({ name: 'Atomic articole', priceCents: 4990, stock: 5 });
		const cart = [{ productId: product.id, qty: 2, priceCents: 4990 }];
		const payload = completedSessionEvent({
			id: 'cs_atomic_items',
			cart,
			amountTotal: 9980,
			email: 'atomic-items@example.ro'
		});
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);

		const { db: faultyDb, fault } = withDbFault(db, 'insert', orderItems);
		fault.arm();
		await expect(processStripeEvent({ ...webhookDeps, db: faultyDb }, event)).rejects.toThrow(
			'injected insert fault'
		);
		expect(fault.hits).toBe(1);

		// NOTHING committed: the stripeSessionId claim AND the processed_events
		// claim rolled back with the failure, stock is untouched, no email
		// attempted — so Stripe's redelivery genuinely retries instead of
		// hitting a headless duplicate (a poisoned event stays retryable).
		expect(
			await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_atomic_items'))
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(processedEvents)
				.where(eq(processedEvents.eventId, 'evt_cs_atomic_items'))
		).toHaveLength(0);
		const [afterFailure] = await db.select().from(products).where(eq(products.id, product.id));
		expect(afterFailure.stock).toBe(5);
		expect(
			await db.select().from(emailLog).where(eq(emailLog.toEmail, 'atomic-items@example.ro'))
		).toHaveLength(0);

		// The SAME event redelivered now succeeds as one complete unit.
		fault.disarm();
		const retried = await processStripeEvent({ ...webhookDeps, db: faultyDb }, event);
		expect(retried.kind).toBe('order-created');
		const rows = await db
			.select()
			.from(orders)
			.where(eq(orders.stripeSessionId, 'cs_atomic_items'));
		expect(rows).toHaveLength(1);
		const items = await db.select().from(orderItems).where(eq(orderItems.orderId, rows[0].id));
		expect(items).toHaveLength(1);
		expect(items[0].qty).toBe(2);
		const [afterRetry] = await db.select().from(products).where(eq(products.id, product.id));
		expect(afterRetry.stock).toBe(3);
		const logs = await db
			.select()
			.from(emailLog)
			.where(eq(emailLog.idempotencyKey, `order-confirmation:${rows[0].id}`));
		expect(logs).toHaveLength(1);
		expect(logs[0].status).toBe('dryrun');
		// The retried delivery is the one that committed the ledger row.
		const [ledger] = await db
			.select()
			.from(processedEvents)
			.where(eq(processedEvents.eventId, 'evt_cs_atomic_items'));
		expect(ledger.outcome).toBe('order-created');
	});

	it('rolls back the order and items when the stock decrement fails', async () => {
		const product = await makeProduct({ name: 'Atomic stoc', priceCents: 2000, stock: 4 });
		const cart = [{ productId: product.id, qty: 1, priceCents: 2000 }];
		const payload = completedSessionEvent({
			id: 'cs_atomic_stock',
			cart,
			amountTotal: 2000,
			email: 'atomic-stock@example.ro'
		});
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);

		const { db: faultyDb, fault } = withDbFault(db, 'update', products);
		fault.arm();
		await expect(processStripeEvent({ ...webhookDeps, db: faultyDb }, event)).rejects.toThrow(
			'injected update fault'
		);
		expect(
			await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_atomic_stock'))
		).toHaveLength(0);
		expect(
			await db.select().from(emailLog).where(eq(emailLog.toEmail, 'atomic-stock@example.ro'))
		).toHaveLength(0);

		fault.disarm();
		const retried = await processStripeEvent({ ...webhookDeps, db: faultyDb }, event);
		expect(retried.kind).toBe('order-created');
		const [after] = await db.select().from(products).where(eq(products.id, product.id));
		expect(after.stock).toBe(3);
	});

	it('concurrent deliveries of the same event yield exactly one complete order', async () => {
		const product = await makeProduct({ name: 'Concurent', priceCents: 1500, stock: 6 });
		const cart = [{ productId: product.id, qty: 1, priceCents: 1500 }];
		const payload = completedSessionEvent({
			id: 'cs_concurrent',
			cart,
			amountTotal: 1500,
			email: 'concurrent@example.ro'
		});
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);

		const outcomes = await Promise.all([
			processStripeEvent(webhookDeps, event),
			processStripeEvent(webhookDeps, event)
		]);
		expect(outcomes.map((o) => o.kind).sort()).toEqual(['duplicate-event', 'order-created']);

		const rows = await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_concurrent'));
		expect(rows).toHaveLength(1);
		expect(
			await db.select().from(orderItems).where(eq(orderItems.orderId, rows[0].id))
		).toHaveLength(1);
		const [after] = await db.select().from(products).where(eq(products.id, product.id));
		expect(after.stock).toBe(5);
		expect(
			await db
				.select()
				.from(emailLog)
				.where(eq(emailLog.idempotencyKey, `order-confirmation:${rows[0].id}`))
		).toHaveLength(1);
	});

	it('an email transport failure never rolls back the order, and a redelivery retries the send', async () => {
		const product = await makeProduct({ name: 'Email căzut', priceCents: 3000, stock: 2 });
		const cart = [{ productId: product.id, qty: 1, priceCents: 3000 }];
		const payload = completedSessionEvent({
			id: 'cs_email_error',
			cart,
			amountTotal: 3000,
			email: 'email-error@example.ro'
		});
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);

		const failingEmail = createEmailSender({
			db,
			dryRun: false,
			from: 'test@example.ro',
			transport: {
				send: async () => {
					throw new Error('resend down');
				}
			}
		});
		const first = await processStripeEvent(
			{ db, email: failingEmail, siteName: 'Better Sleep' },
			event
		);
		expect(first.kind).toBe('order-created');

		const rows = await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_email_error'));
		expect(rows).toHaveLength(1);
		const [afterFirst] = await db.select().from(products).where(eq(products.id, product.id));
		expect(afterFirst.stock).toBe(1);
		const key = `order-confirmation:${rows[0].id}`;
		const failedLogs = await db.select().from(emailLog).where(eq(emailLog.idempotencyKey, key));
		expect(failedLogs).toHaveLength(1);
		expect(failedLogs[0].status).toBe('error');

		// Redelivery: still exactly one order (no double decrement), and the
		// FAILED email is re-attempted — idempotency only skips delivered sends.
		const second = await processStripeEvent(webhookDeps, event);
		expect(second.kind).toBe('duplicate-event');
		expect(
			await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_email_error'))
		).toHaveLength(1);
		const [afterSecond] = await db.select().from(products).where(eq(products.id, product.id));
		expect(afterSecond.stock).toBe(1);
		const retriedLogs = await db.select().from(emailLog).where(eq(emailLog.idempotencyKey, key));
		expect(retriedLogs).toHaveLength(1);
		expect(retriedLogs[0].status).toBe('dryrun');
	});

	it('an email sender that throws outright cannot undo the committed order', async () => {
		const product = await makeProduct({ name: 'Email aruncă', priceCents: 2500, stock: 3 });
		const cart = [{ productId: product.id, qty: 1, priceCents: 2500 }];
		const payload = completedSessionEvent({
			id: 'cs_email_throw',
			cart,
			amountTotal: 2500,
			email: 'email-throw@example.ro'
		});
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);

		const throwingEmail: EmailSender = {
			send: async () => {
				throw new Error('email infrastructure down');
			}
		};
		await expect(
			processStripeEvent({ db, email: throwingEmail, siteName: 'Better Sleep' }, event)
		).rejects.toThrow('email infrastructure down');

		// The order was committed before the send, so it survives the throw.
		const rows = await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_email_throw'));
		expect(rows).toHaveLength(1);
		expect(
			await db.select().from(orderItems).where(eq(orderItems.orderId, rows[0].id))
		).toHaveLength(1);
		const [after] = await db.select().from(products).where(eq(products.id, product.id));
		expect(after.stock).toBe(2);

		// Stripe redelivers (the route 500s on the throw): no second order, and
		// the email finally goes out.
		const second = await processStripeEvent(webhookDeps, event);
		expect(second.kind).toBe('duplicate-event');
		expect(
			await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_email_throw'))
		).toHaveLength(1);
		const logs = await db
			.select()
			.from(emailLog)
			.where(eq(emailLog.idempotencyKey, `order-confirmation:${rows[0].id}`));
		expect(logs).toHaveLength(1);
		expect(logs[0].status).toBe('dryrun');
	});
});

describe('webhook: charge.refunded', () => {
	it('flips the matching order to refunded; unmatched refunds are reported', async () => {
		const product = await makeProduct({ name: 'De rambursat', priceCents: 3000 });
		const cart = [{ productId: product.id, qty: 1, priceCents: 3000 }];
		const payload = completedSessionEvent({
			id: 'cs_refund',
			cart,
			amountTotal: 3000,
			paymentIntent: 'pi_refund_me'
		});
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);
		await processStripeEvent(webhookDeps, event);

		const refundPayload = JSON.stringify({
			id: 'evt_refund',
			object: 'event',
			type: 'charge.refunded',
			data: { object: { id: 'ch_1', object: 'charge', payment_intent: 'pi_refund_me' } }
		});
		const refundEvent = await verifyStripeEvent(
			refundPayload,
			signedHeader(refundPayload),
			WEBHOOK_SECRET
		);
		const outcome = await processStripeEvent(webhookDeps, refundEvent);
		expect(outcome.kind).toBe('refund-marked');

		const [order] = await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_refund'));
		expect(order.status).toBe('refunded');

		const unmatchedPayload = JSON.stringify({
			id: 'evt_refund_unmatched',
			object: 'event',
			type: 'charge.refunded',
			data: { object: { id: 'ch_2', object: 'charge', payment_intent: 'pi_unknown' } }
		});
		const unmatchedEvent = await verifyStripeEvent(
			unmatchedPayload,
			signedHeader(unmatchedPayload),
			WEBHOOK_SECRET
		);
		// FIX-10 (audit P0 #3): a refund with no order is REMEMBERED for the
		// order that may still arrive, no longer acknowledged and forgotten.
		expect((await processStripeEvent(webhookDeps, unmatchedEvent)).kind).toBe('refund-pending');
	});

	it('delivered twice, the refund is applied once and the redelivery reports the ledger hit', async () => {
		const product = await makeProduct({ name: 'Rambursare dublă', priceCents: 3000 });
		const cart = [{ productId: product.id, qty: 1, priceCents: 3000 }];
		const payload = completedSessionEvent({
			id: 'cs_refund_twice',
			cart,
			amountTotal: 3000,
			paymentIntent: 'pi_refund_twice'
		});
		const event = await verifyStripeEvent(payload, signedHeader(payload), WEBHOOK_SECRET);
		await processStripeEvent(webhookDeps, event);

		const refundPayload = JSON.stringify({
			id: 'evt_refund_twice',
			object: 'event',
			type: 'charge.refunded',
			data: { object: { id: 'ch_twice', object: 'charge', payment_intent: 'pi_refund_twice' } }
		});
		const refundEvent = await verifyStripeEvent(
			refundPayload,
			signedHeader(refundPayload),
			WEBHOOK_SECRET
		);

		const first = await processStripeEvent(webhookDeps, refundEvent);
		expect(first.kind).toBe('refund-marked');
		// Redelivery of the SAME provider event: acknowledged via the ledger,
		// effect NOT repeated. (Before the ledger this re-ran the whole
		// handler and reported a second 'refund-marked'.)
		const second = await processStripeEvent(webhookDeps, refundEvent);
		expect(second).toEqual({
			kind: 'duplicate-event',
			eventId: 'evt_refund_twice',
			firstOutcome: 'refund-marked'
		});

		const [order] = await db
			.select()
			.from(orders)
			.where(eq(orders.stripeSessionId, 'cs_refund_twice'));
		expect(order.status).toBe('refunded');
		// Exactly ONE refund entry in the audit trail — the proof the effect
		// ran once. The trail also has the creation event.
		const trail = await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id));
		expect(trail.filter((e) => e.kind === 'refund-marked')).toHaveLength(1);
		expect(trail.filter((e) => e.kind === 'refund-marked')[0]).toMatchObject({
			actor: 'stripe-webhook',
			note: 'ch_twice'
		});
	});
});

describe('webhook: processed_events ledger', () => {
	it('the same session under a NEW event id is still one order (session claim, not ledger)', async () => {
		const product = await makeProduct({ name: 'Sesiune reemisă', priceCents: 2000, stock: 5 });
		const cart = [{ productId: product.id, qty: 1, priceCents: 2000 }];
		const firstPayload = completedSessionEvent({ id: 'cs_reissued', cart, amountTotal: 2000 });
		const first = await verifyStripeEvent(firstPayload, signedHeader(firstPayload), WEBHOOK_SECRET);
		expect((await processStripeEvent(webhookDeps, first)).kind).toBe('order-created');

		const secondPayload = completedSessionEvent({
			id: 'cs_reissued',
			cart,
			amountTotal: 2000,
			eventId: 'evt_cs_reissued_resent'
		});
		const second = await verifyStripeEvent(
			secondPayload,
			signedHeader(secondPayload),
			WEBHOOK_SECRET
		);
		const outcome = await processStripeEvent(webhookDeps, second);
		expect(outcome).toEqual({ kind: 'duplicate-session', sessionId: 'cs_reissued' });

		// One order, stock decremented once — and BOTH event ids are on the
		// ledger, the second recording why it did nothing.
		expect(
			await db.select().from(orders).where(eq(orders.stripeSessionId, 'cs_reissued'))
		).toHaveLength(1);
		const [after] = await db.select().from(products).where(eq(products.id, product.id));
		expect(after.stock).toBe(4);
		const [resent] = await db
			.select()
			.from(processedEvents)
			.where(eq(processedEvents.eventId, 'evt_cs_reissued_resent'));
		expect(resent.outcome).toBe('duplicate-session');
	});
});
