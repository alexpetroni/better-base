import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { createDb } from '../src/lib/db/client.ts';
import { emailLog } from '../src/lib/modules/email/schema.ts';
import { invoiceLines, invoices } from '../src/lib/modules/invoice/schema.ts';
import { buildCartMetadata } from '../src/lib/modules/shop/checkout.ts';
import { orders, shipments } from '../src/lib/modules/shop/schema.ts';
import { DEMO_PRODUCTS } from '../src/lib/modules/shop/seed-products.ts';
import { buildShippingMetadata } from '../src/lib/modules/shop/shipping.ts';
import { E2E_ADMIN, E2E_STRIPE_WEBHOOK_SECRET, SITE_DB_NAMES, siteDatabaseUrl } from './env.ts';
import { login } from './helpers.ts';

// Editor-role access is covered in admin.e2e.ts: /admin/settings answers 403
// and the sidebar entry is hidden (settings is in ADMIN_ONLY_SECTIONS).

test('admin saves company identification; values persist after reload', async ({ page }) => {
	await login(page, E2E_ADMIN);
	await page.goto('/admin/settings');
	// Inputs carry server-echoed values — typing before hydration races.
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');

	await page.getByTestId('settings-field-company.legalName').fill('E2E Exemplu SRL');
	await page.getByTestId('settings-field-company.cui').fill('RO12345678');
	await page.getByTestId('settings-field-company.regCom').fill('J40/1234/2024');
	await page.getByTestId('settings-field-company.address').fill('Str. Exemplu 1, București');
	await page.getByTestId('settings-field-company.contactEmail').fill('contact@exemplu.ro');
	await page.getByTestId('settings-field-company.contactPhone').fill('+40 700 000 000');
	await page.getByTestId('settings-field-company.vatRegistered').check();
	await page.getByTestId('settings-save-company').click();

	await expect(page.getByTestId('settings-saved')).toBeVisible();
	await expect(page.getByTestId('settings-audit')).toContainText(E2E_ADMIN.email);

	await page.reload();
	await expect(page.getByTestId('settings-field-company.legalName')).toHaveValue('E2E Exemplu SRL');
	await expect(page.getByTestId('settings-field-company.vatRegistered')).toBeChecked();
});

test('invalid input shows a field error and persists nothing', async ({ page }) => {
	await login(page, E2E_ADMIN);
	await page.goto('/admin/settings');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');

	await page.getByTestId('settings-field-company.cui').fill('not-a-cui');
	await page.getByTestId('settings-save-company').click();

	await expect(page.getByTestId('settings-error-company.cui')).toBeVisible();
	// The previous test's valid save survives the refused one.
	await page.reload();
	await expect(page.getByTestId('settings-field-company.cui')).toHaveValue('RO12345678');
});

// Depends on the company data saved by the first test (tests in this file run
// in order); lives here so no parallel spec races the shared site_settings.
test('saved identification + ANPC links render in the footer and on legal pages', async ({
	page
}) => {
	await login(page, E2E_ADMIN);
	await page.goto('/admin/settings');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
	await page.getByTestId('settings-field-legal.anpcSalUrl').fill('https://anpc.ro/ce-este-sal/');
	await page
		.getByTestId('settings-field-legal.anpcSolUrl')
		.fill('https://ec.europa.eu/consumers/odr');
	await page.getByTestId('settings-save-legal').click();
	await expect(page.getByTestId('settings-saved')).toBeVisible();

	// Footer, on every public page — home and a legal page as witnesses.
	await page.goto('/');
	const footer = page.getByTestId('legal-identity');
	await expect(footer.getByTestId('legal-identity-name')).toHaveText('E2E Exemplu SRL');
	// VAT-registered ⇒ the CUI carries the RO prefix.
	await expect(footer.getByTestId('legal-identity-cui')).toContainText('RO12345678');
	await expect(footer.getByTestId('legal-identity-regcom')).toContainText('J40/1234/2024');
	await expect(footer.getByTestId('legal-identity-address')).toContainText('Str. Exemplu 1');
	await expect(footer.getByTestId('legal-identity-email')).toContainText('contact@exemplu.ro');
	const sal = footer.getByTestId('legal-anpc-sal');
	await expect(sal).toHaveAttribute('href', 'https://anpc.ro/ce-este-sal/');
	await expect(sal).toHaveAttribute('rel', 'noopener');
	await expect(footer.getByTestId('legal-anpc-sol')).toHaveAttribute(
		'href',
		'https://ec.europa.eu/consumers/odr'
	);

	// Legal pages carry the identification block above the lawyer-editable prose.
	await page.goto('/pagini/politica-de-confidentialitate');
	await expect(
		page.getByTestId('legal-page-identity').getByTestId('legal-identity-name')
	).toHaveText('E2E Exemplu SRL');
	await page.goto('/pagini/termeni-si-conditii');
	await expect(
		page.getByTestId('legal-page-identity').getByTestId('legal-identity-cui')
	).toContainText('RO12345678');

	// The cookie policy lists the real cookie inventory and links from the footer.
	await page.goto('/');
	await page.getByRole('link', { name: 'Politica de cookie-uri' }).click();
	await expect(page.getByTestId('cookie-table')).toBeVisible();
	for (const name of ['better-auth.session_token', 'cart', 'cookie_consent', 'chat_session']) {
		await expect(page.getByTestId('cookie-table')).toContainText(name);
	}
	await expect(page.getByTestId('consent-manager')).toBeVisible();
});

// The invoice-document flow lives in THIS file on purpose (like the legal-
// surface test above): it depends on the company identification saved by the
// first test, and site_settings is shared state no parallel spec file may
// touch. Mock-Stripe purchase → invoice issued by the webhook → the buyer
// downloads it from the success page; the admin sees, downloads and re-sends
// it; nobody else can fetch it.
test('a purchase yields a downloadable invoice; access is owner-or-admin only', async ({
	page,
	request
}, testInfo) => {
	const siteId = testInfo.project.name as keyof typeof SITE_DB_NAMES;
	const db = createDb(siteDatabaseUrl(siteId));
	// Constructed only for its offline webhook signing helper.
	const stripeSigner = new Stripe('sk_test_offline_signing_only');
	const [, CEAI] = DEMO_PRODUCTS;

	try {
		// --- Complete the issuer configuration (series prefix is required).
		await login(page, E2E_ADMIN);
		await page.goto('/admin/settings');
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
		await page.getByTestId('settings-field-invoice.seriesPrefix').fill('E2E');
		await page.getByTestId('settings-field-invoice.issuerPlace').fill('București');
		await page.getByTestId('settings-save-invoice').click();
		await expect(page.getByTestId('settings-saved')).toBeVisible();

		// --- A signed mock-Stripe webhook creates a paid order + its invoice.
		const sessionId = `cs_test_mock_invoice_${siteId}`;
		const payload = JSON.stringify({
			id: `evt_e2e_invoice_${siteId}`,
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: sessionId,
					object: 'checkout.session',
					amount_total: CEAI.priceCents,
					currency: 'ron',
					payment_intent: `pi_e2e_invoice_${siteId}`,
					payment_status: 'paid',
					customer_details: { email: 'factura-client@example.com', name: 'Ștefan Țăranu' },
					collected_information: {
						shipping_details: {
							name: 'Ștefan Țăranu',
							address: {
								line1: 'Str. Înțelepciunii 3',
								city: 'Cluj-Napoca',
								postal_code: '400001',
								country: 'RO'
							}
						}
					},
					metadata: {
						cart: buildCartMetadata([{ productId: CEAI.id, qty: 1, priceCents: CEAI.priceCents }])
					}
				}
			}
		});
		const webhook = await page.context().request.post('/api/stripe/webhook', {
			headers: {
				'content-type': 'application/json',
				'stripe-signature': stripeSigner.webhooks.generateTestHeaderString({
					payload,
					secret: E2E_STRIPE_WEBHOOK_SECRET
				})
			},
			data: payload
		});
		expect(await webhook.json()).toEqual({ received: true, outcome: 'order-created' });

		// The dry-run confirmation email captured the PDF attachment + number.
		const [order] = await db.select().from(orders).where(eq(orders.stripeSessionId, sessionId));
		const [confirmation] = await db
			.select()
			.from(emailLog)
			.where(eq(emailLog.idempotencyKey, `order-confirmation:${order.id}`));
		expect(confirmation.status).toBe('dryrun');
		expect(confirmation.attachments).toHaveLength(1);
		expect(confirmation.attachments![0].filename).toMatch(/^Factura-E2E-\d{4}\.pdf$/);
		expect(confirmation.data.invoiceNumber).toMatch(/^E2E-\d{4}$/);

		// --- Buyer side: the success page links signed PDF/XML downloads.
		await page.goto(`/cos/succes?session_id=${sessionId}`);
		await expect(page.getByTestId('success-invoice')).toBeVisible();
		const pdfHref = await page.getByTestId('success-invoice-pdf').first().getAttribute('href');
		const xmlHref = await page.getByTestId('success-invoice-xml').first().getAttribute('href');

		// The `request` fixture shares no cookies with the (admin-logged-in)
		// page: it is the stranger holding only a link. The signed URL works —
		// it IS the capability — a tampered or missing token must not.
		const anonymous = await request.get(pdfHref!);
		expect(anonymous.status()).toBe(200);
		expect(anonymous.headers()['content-type']).toBe('application/pdf');
		expect(anonymous.headers()['content-disposition']).toMatch(/^attachment; filename="Factura-/);
		expect((await anonymous.body()).subarray(0, 5).toString()).toBe('%PDF-');

		const xmlResponse = await request.get(xmlHref!);
		expect(xmlResponse.status()).toBe(200);
		expect(await xmlResponse.text()).toContain('CIUS-RO');

		const bare = pdfHref!.split('?')[0];
		const tampered = `${bare}?t=${pdfHref!.split('t=')[1].replace(/.{4}$/, 'AAAA')}`;
		for (const [label, url] of [
			['no token', bare],
			['tampered token', tampered]
		]) {
			const response = await request.get(url);
			expect(response.status(), label).toBe(403);
		}

		// --- Admin side (the page still holds the admin session): order
		// detail shows the document with downloads.
		await page.goto('/admin/orders?f=all');
		await page
			.locator(`[data-testid="order-row"][data-session="${sessionId}"]`)
			.locator('a')
			.click();
		const invoiceBox = page.locator('[data-testid="order-invoice"][data-kind="invoice"]');
		await expect(invoiceBox).toBeVisible();
		await expect(invoiceBox.locator('.font-mono')).toHaveText(/^E2E-\d{4}$/);
		const adminPdf = await page.request.get(
			(await invoiceBox.getByTestId('order-invoice-pdf').getAttribute('href'))!
		);
		expect(adminPdf.status()).toBe(200);
		expect((await adminPdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

		// Re-send the invoice email; the send is recorded (dry-run) once.
		await page.getByTestId('order-invoice-resend').click();
		await expect(page.getByTestId('order-invoice-resent')).toBeVisible();

		// --- The accountant export for this month contains the document.
		const month = new Date().toISOString().slice(0, 7);
		const exportResponse = await page.request.get(`/admin/orders/export?month=${month}`);
		expect(exportResponse.status()).toBe(200);
		expect(exportResponse.headers()['content-type']).toBe('application/zip');
		expect((await exportResponse.body()).subarray(0, 2).toString()).toBe('PK');
	} finally {
		await db.$client.end();
	}
});

// NEXT-8. In THIS file for the same reason as the invoice flow above: it
// configures shipping through the real settings UI (shared site_settings) and
// relies on the issuer config the previous test saved. Shipping settings →
// cart offers the options → a purchase with the express option selected →
// the order carries the shipping amount, the invoice reconciles to the
// charged total → the admin generates the AWB → shipped, tracking link,
// label download, one shipping email.
test('shipping is priced from settings, charged, invoiced and shipped with an AWB', async ({
	page
}, testInfo) => {
	const siteId = testInfo.project.name as keyof typeof SITE_DB_NAMES;
	const db = createDb(siteDatabaseUrl(siteId));
	const stripeSigner = new Stripe('sk_test_offline_signing_only');
	const [, CEAI] = DEMO_PRODUCTS;
	const EXPRESS_PRICE = 3490;

	try {
		// --- Configure delivery pricing in /admin/settings (data, not code).
		await login(page, E2E_ADMIN);
		await page.goto('/admin/settings');
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
		await page.getByTestId('settings-field-shop.shippingStandardPriceBani').fill('19,90');
		await page.getByTestId('settings-field-shop.shippingExpressName').fill('Curier rapid');
		await page.getByTestId('settings-field-shop.shippingExpressPriceBani').fill('34,90');
		await page.getByTestId('settings-field-shop.shippingExpressEta').fill('24h');
		await page.getByTestId('settings-save-shop').click();
		await expect(page.getByTestId('settings-saved')).toBeVisible();

		// --- The cart offers both options at the configured prices.
		await page.goto(`/magazin/${CEAI.slug}`);
		await page.getByTestId('product-add-to-cart').click();
		await expect(page).toHaveURL(/\/cos$/);
		await expect(page.locator('[data-testid="cart-shipping-option"]')).toHaveCount(2);
		await expect(
			page.locator('[data-testid="cart-shipping-price"][data-option="standard"]')
		).toHaveText('19,90 lei');
		await expect(
			page.locator('[data-testid="cart-shipping-price"][data-option="express"]')
		).toHaveText('34,90 lei');
		await page.locator('[data-testid="cart-shipping-option"][data-option="express"]').check();

		// --- Checkout with the express option (form post; the browser must not
		// navigate to the external mock-Stripe URL).
		const checkout = await page.context().request.post('/cos?/checkout', {
			headers: { origin: testInfo.project.use.baseURL!, accept: 'text/html' },
			form: { shippingOption: 'express' },
			maxRedirects: 0
		});
		expect(checkout.status()).toBe(303);
		const sessionId = checkout.headers()['location'].split('/').pop()!;

		// --- The signed webhook creates the order with the shipping amount.
		const payload = JSON.stringify({
			id: `evt_e2e_shipping_${siteId}`,
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: sessionId,
					object: 'checkout.session',
					amount_total: CEAI.priceCents + EXPRESS_PRICE,
					shipping_cost: { amount_total: EXPRESS_PRICE },
					currency: 'ron',
					payment_intent: `pi_e2e_shipping_${siteId}`,
					payment_status: 'paid',
					customer_details: { email: 'livrare-client@example.com', name: 'Ana Pop' },
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
					metadata: {
						cart: buildCartMetadata([{ productId: CEAI.id, qty: 1, priceCents: CEAI.priceCents }]),
						ship: buildShippingMetadata({
							id: 'express',
							name: 'Curier rapid',
							priceCents: EXPRESS_PRICE,
							etaText: '24h',
							freeOverThreshold: false
						})
					}
				}
			}
		});
		const webhook = await page.context().request.post('/api/stripe/webhook', {
			headers: {
				'content-type': 'application/json',
				'stripe-signature': stripeSigner.webhooks.generateTestHeaderString({
					payload,
					secret: E2E_STRIPE_WEBHOOK_SECRET
				})
			},
			data: payload
		});
		expect(await webhook.json()).toEqual({ received: true, outcome: 'order-created' });

		const [order] = await db.select().from(orders).where(eq(orders.stripeSessionId, sessionId));
		expect(order.shippingCents).toBe(EXPRESS_PRICE);
		expect(order.shippingName).toBe('Curier rapid');
		expect(order.amountTotalCents).toBe(CEAI.priceCents + EXPRESS_PRICE);

		// The invoice reconciles to the charged total, shipping as its own line.
		const [invoice] = await db.select().from(invoices).where(eq(invoices.orderId, order.id));
		expect(invoice.grossTotalCents).toBe(order.amountTotalCents);
		const lines = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, invoice.id));
		const transport = lines.find((l) => l.description === 'Transport — Curier rapid');
		expect(transport?.grossCents).toBe(EXPRESS_PRICE);

		// --- Admin generates the AWB from the order detail.
		await page.goto('/admin/orders?f=all');
		await page
			.locator(`[data-testid="order-row"][data-session="${sessionId}"]`)
			.locator('a')
			.click();
		await expect(page.getByTestId('order-detail-shipping-cost')).toHaveText('34,90 lei');
		await page.getByTestId('order-shipment-generate').click();

		// Shipped, with the shipment box replacing the generate button.
		await expect(page.getByTestId('order-detail-fulfillment')).toHaveText('expediată');
		const shipmentBox = page.getByTestId('order-shipment');
		await expect(shipmentBox).toBeVisible();
		const awb = (await page.getByTestId('order-shipment-awb').textContent())!.trim();
		expect(awb).toMatch(/^MOCKAWB/);
		await expect(page.getByTestId('order-shipment-tracking')).toHaveAttribute(
			'href',
			new RegExp(`${awb}$`)
		);
		await expect(
			page.locator('[data-testid="order-event"][data-kind="awb-generated"]')
		).toHaveCount(1);

		// The label downloads through the authenticated route.
		const label = await page.request.get(
			(await page.getByTestId('order-shipment-label').getAttribute('href'))!
		);
		expect(label.status()).toBe(200);
		expect(label.headers()['content-type']).toBe('application/pdf');
		expect((await label.body()).subarray(0, 5).toString()).toBe('%PDF-');

		// Exactly one shipping notification, keyed on the AWB, dry-run captured.
		const [shipmentRow] = await db.select().from(shipments).where(eq(shipments.orderId, order.id));
		const notifications = await db
			.select()
			.from(emailLog)
			.where(eq(emailLog.idempotencyKey, `shipping-notification:${shipmentRow.awb}`));
		expect(notifications).toHaveLength(1);
		expect(notifications[0].status).toBe('dryrun');
		expect(notifications[0].toEmail).toBe('livrare-client@example.com');
	} finally {
		await db.$client.end();
	}
});
