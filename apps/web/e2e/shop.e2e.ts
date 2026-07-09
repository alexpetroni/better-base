import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { createDb } from '../src/lib/db/client.ts';
import { buildCartMetadata } from '../src/lib/modules/shop/checkout.ts';
import { orders, products } from '../src/lib/modules/shop/schema.ts';
import { DEMO_PRODUCTS } from '../src/lib/modules/shop/seed-products.ts';
import { E2E_ADMIN, E2E_STRIPE_WEBHOOK_SECRET, SITE_DB_NAMES, siteDatabaseUrl } from './env.ts';
import { login } from './helpers.ts';

// The shop happy path on BOTH sites, against the seeded demo catalog (all
// products are somn-tagged, active on sleep AND life): browse → add 2
// products → edit a quantity → checkout-session creation (MOCK gateway;
// the redirect URL is asserted, Stripe is never called) → a SIGNED
// simulated webhook creates the order → success page + admin see it.

const [MASCA, CEAI, LUMINA] = DEMO_PRODUCTS;
// Constructed only for its offline webhook signing helper.
const stripeSigner = new Stripe('sk_test_offline_signing_only');

test('visitor browses, fills the cart, reaches checkout; a signed webhook creates the order', async ({
	page,
	baseURL
}, testInfo) => {
	const siteId = testInfo.project.name as keyof typeof SITE_DB_NAMES;
	const db = createDb(siteDatabaseUrl(siteId));
	const clientEmail = 'e2e-client@example.com';

	try {
		// --- Catalog: the 3 seeded products render with real imgproxy covers.
		await page.goto('/magazin');
		await expect(page.locator('[data-testid="product-card"]')).toHaveCount(3);
		const mascaCard = page.locator(`[data-testid="product-card"][data-slug="${MASCA.slug}"]`);
		await expect(mascaCard.getByTestId('product-price')).toHaveText('89,90 lei');
		const cover = mascaCard.locator('img');
		await expect(cover).toBeVisible();
		expect(await cover.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

		// --- Product page: gallery renders, add 2 units to the cart.
		await mascaCard.locator('a').first().click();
		await expect(page.getByTestId('product-title')).toHaveText(MASCA.name);
		await expect(page.locator('[data-testid="product-gallery"] img')).toHaveCount(1);
		await page.getByTestId('product-qty').fill('2');
		await page.getByTestId('product-add-to-cart').click();

		// Add-to-cart lands on the cart page; the header badge counts units.
		await expect(page).toHaveURL(/\/cos$/);
		const mascaLine = page.locator(`[data-testid="cart-line"][data-slug="${MASCA.slug}"]`);
		await expect(mascaLine.getByTestId('cart-qty')).toHaveValue('2');
		await expect(page.getByTestId('cart-count')).toHaveText('2');

		// --- Second product.
		await page.goto(`/magazin/${CEAI.slug}`);
		await page.getByTestId('product-add-to-cart').click();
		await expect(page).toHaveURL(/\/cos$/);
		await expect(page.locator('[data-testid="cart-line"]')).toHaveCount(2);
		await expect(page.getByTestId('cart-count')).toHaveText('3');

		// --- Edit the quantity: 2×mască → 1×mască; totals are integer-cent math.
		await mascaLine.getByTestId('cart-qty').fill('1');
		await mascaLine.getByTestId('cart-qty-update').click();
		await expect(mascaLine.getByTestId('cart-line-total')).toHaveText('89,90 lei');
		const expectedTotalCents = MASCA.priceCents + CEAI.priceCents;
		await expect(page.getByTestId('cart-total')).toHaveText('124,40 lei');

		// --- Checkout: the action must 303 to the (mock) Stripe Checkout URL.
		// `accept: text/html` forces the plain form-post protocol — with the
		// default */* SvelteKit negotiates its JSON action protocol instead
		// (HTTP 200 + {type:'redirect'} body) and there is no Location header.
		const checkout = await page.context().request.post('/cos?/checkout', {
			headers: { origin: baseURL!, accept: 'text/html' },
			form: {},
			maxRedirects: 0
		});
		expect(checkout.status()).toBe(303);
		const location = checkout.headers()['location'];
		expect(location).toContain('https://checkout.stripe.com/c/pay/cs_test_mock_');
		const sessionId = location.split('/').pop()!;

		// --- Webhook simulation: a SIGNED checkout.session.completed for that
		// session. Tampered/foreign signatures must be rejected with 400 first.
		const payload = JSON.stringify({
			id: `evt_e2e_${siteId}`,
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: sessionId,
					object: 'checkout.session',
					amount_total: expectedTotalCents,
					currency: 'ron',
					payment_intent: `pi_e2e_${siteId}`,
					payment_status: 'paid',
					customer_details: { email: clientEmail, name: 'E2E Client' },
					collected_information: {
						shipping_details: {
							name: 'E2E Client',
							address: {
								line1: 'Str. Viselor 1',
								city: 'București',
								postal_code: '010101',
								country: 'RO'
							}
						}
					},
					metadata: {
						cart: buildCartMetadata([
							{ productId: MASCA.id, qty: 1, priceCents: MASCA.priceCents },
							{ productId: CEAI.id, qty: 1, priceCents: CEAI.priceCents }
						])
					}
				}
			}
		});

		const badSignature = await page.context().request.post('/api/stripe/webhook', {
			headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
			data: payload
		});
		expect(badSignature.status()).toBe(400);
		expect(
			await db.select().from(orders).where(eq(orders.stripeSessionId, sessionId))
		).toHaveLength(0);

		const signature = stripeSigner.webhooks.generateTestHeaderString({
			payload,
			secret: E2E_STRIPE_WEBHOOK_SECRET
		});
		const webhook = await page.context().request.post('/api/stripe/webhook', {
			headers: { 'content-type': 'application/json', 'stripe-signature': signature },
			data: payload
		});
		expect(webhook.status()).toBe(200);
		expect(await webhook.json()).toEqual({ received: true, outcome: 'order-created' });

		// A duplicate delivery is acknowledged but creates nothing new.
		const duplicate = await page.context().request.post('/api/stripe/webhook', {
			headers: { 'content-type': 'application/json', 'stripe-signature': signature },
			data: payload
		});
		expect(await duplicate.json()).toEqual({ received: true, outcome: 'duplicate-session' });
		expect(
			await db.select().from(orders).where(eq(orders.stripeSessionId, sessionId))
		).toHaveLength(1);

		// Tracked stock decremented once (mască 25 → 24); untracked stays null.
		const [mascaRow] = await db.select().from(products).where(eq(products.id, MASCA.id));
		expect(mascaRow.stock).toBe(24);
		const [ceaiRow] = await db.select().from(products).where(eq(products.id, CEAI.id));
		expect(ceaiRow.stock).toBeNull();

		// --- Success page: order summary by session id; the cart is cleared.
		await page.goto(`/cos/succes?session_id=${sessionId}`);
		await expect(page.getByTestId('success-order')).toContainText(clientEmail);
		await expect(page.locator('[data-testid="success-item"]')).toHaveCount(2);
		await expect(page.getByTestId('success-total')).toHaveText('124,40 lei');
		await expect(page.getByTestId('cart-count')).toHaveCount(0);

		// --- Admin sees the order with the correct totals and shipping address.
		await login(page, E2E_ADMIN);
		await page.goto('/admin/orders');
		const orderRow = page.locator(`[data-testid="order-row"][data-session="${sessionId}"]`);
		await expect(orderRow.getByTestId('order-row-email')).toHaveText(clientEmail);
		await expect(orderRow.getByTestId('order-row-total')).toHaveText('124,40 lei');
		await expect(orderRow.getByTestId('order-row-status')).toHaveText('plătită');
		await orderRow.locator('a').click();
		await expect(page.getByTestId('order-detail-total')).toHaveText('124,40 lei');
		await expect(page.locator('[data-testid="order-item"]')).toHaveCount(2);
		await expect(page.getByTestId('order-detail-shipping')).toContainText('București');
	} finally {
		await db.$client.end();
	}
});

test('a tracked product at zero stock shows a disabled buy button', async ({ page }, testInfo) => {
	const siteId = testInfo.project.name as keyof typeof SITE_DB_NAMES;
	const db = createDb(siteDatabaseUrl(siteId));

	try {
		await db.update(products).set({ stock: 0 }).where(eq(products.id, LUMINA.id));

		await page.goto(`/magazin/${LUMINA.slug}`);
		await expect(page.getByTestId('product-add-to-cart')).toBeDisabled();
		await expect(page.getByTestId('product-add-to-cart')).toHaveText('Stoc epuizat');
		await page.goto('/magazin');
		await expect(
			page
				.locator(`[data-testid="product-card"][data-slug="${LUMINA.slug}"]`)
				.getByTestId('product-out-of-stock')
		).toBeVisible();
	} finally {
		await db.update(products).set({ stock: LUMINA.stock }).where(eq(products.id, LUMINA.id));
		await db.$client.end();
	}
});
