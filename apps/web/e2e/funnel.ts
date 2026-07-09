import { expect, test, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { resolveSiteConfig } from '../src/lib/config/index.ts';
import { createDb } from '../src/lib/db/client.ts';
import { subscribers } from '../src/lib/modules/crm/schema.ts';
import { emailLog } from '../src/lib/modules/email/schema.ts';
import { buildCartMetadata } from '../src/lib/modules/shop/checkout.ts';
import { orders } from '../src/lib/modules/shop/schema.ts';
import { DEMO_PRODUCTS } from '../src/lib/modules/shop/seed-products.ts';
import { E2E_STRIPE_WEBHOOK_SECRET, SITE_DB_NAMES, siteDatabaseUrl } from './env.ts';

/**
 * THE launch-readiness walk: one visitor goes home → pillar page → article →
 * quiz → subscribe (dry-run emails) → shop → cart → mocked checkout (signed
 * webhook creates the order) → chat, plus consent banner, legal pages and the
 * health endpoint. One spec file per site config (funnel-sleep / funnel-life)
 * instantiates this against its own preview server + database.
 *
 * Everything external is mocked/dry-run by the preview servers' env: email
 * EMAIL_DRYRUN, Stripe mock gateway, mock chat provider.
 */

// CEAI is the untracked-stock demo product — the funnel purchase must not
// race the stock assertions the shop spec makes about the other two.
const CEAI = DEMO_PRODUCTS[1];
const QUIZ_SLUG = 'evaluare-somn';

// Constructed only for its offline webhook signing helper.
const stripeSigner = new Stripe('sk_test_offline_signing_only');

async function pick(page: Page, questionId: string, value: string) {
	await page.locator(`input[name="${questionId}"][value="${value}"]`).check();
}

async function pickLikert(page: Page, questionId: string, value: string) {
	await page.locator(`label:has(input[name="${questionId}"][value="${value}"])`).click();
}

export function defineFunnelSpec(siteId: keyof typeof SITE_DB_NAMES) {
	const site = resolveSiteConfig(siteId);

	test.describe(`full funnel — ${siteId}`, () => {
		test('visitor walks the whole funnel: content → quiz → subscribe → buy → chat', async ({
			page,
			baseURL
		}) => {
			test.skip(
				test.info().project.name !== siteId,
				'this funnel spec belongs to the other site project'
			);
			const visitorEmail = `e2e-full-funnel@example.com`;
			const db = createDb(siteDatabaseUrl(siteId));

			try {
				// --- Ops: the health endpoint answers 200 with both checks green.
				const health = await page.request.get('/api/health');
				expect(health.status()).toBe(200);
				expect(await health.json()).toEqual({
					status: 'ok',
					checks: { db: 'ok', storage: 'ok' }
				});

				// --- Home: brand, pillars from config, cookie-consent banner.
				await page.context().clearCookies(); // drop the pre-dismissed consent state
				await page.goto('/');
				await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
				await expect(page.locator('header')).toContainText(site.name);
				await expect(page.getByTestId('pillar-item')).toHaveCount(site.pillars.length);

				await expect(page.getByTestId('cookie-consent')).toBeVisible();
				await page.getByTestId('consent-accept').click();
				await expect(page.getByTestId('cookie-consent')).toHaveCount(0);
				const consent = (await page.context().cookies()).find((c) => c.name === 'cookie_consent');
				expect(consent?.value).toBe('granted');
				await page.reload(); // the decision persists across navigations
				await expect(page.getByTestId('cookie-consent')).toHaveCount(0);

				// --- Legal surface: footer links reach the DB-backed pages.
				const legalLink = page
					.locator('footer a', { hasText: 'Politica de confidențialitate' })
					.first();
				await legalLink.click();
				await expect(page).toHaveURL(/\/pagini\/politica-de-confidentialitate$/);
				await expect(page.getByTestId('simple-page-body')).toContainText('Drepturile tale');

				// --- Pillar page (somn is active on both sites) → seeded article.
				await page.goto('/sanatate/somn');
				await expect(page.getByTestId('pillar-title')).toBeVisible();
				const articleCard = page.locator('[data-testid="pillar-article-card"]').first();
				await expect(articleCard).toBeVisible();
				await articleCard.click();
				await expect(page).toHaveURL(/\/blog\/[a-z0-9-]+$/);
				await expect(page.getByTestId('article-title')).toBeVisible();
				await expect(page.getByTestId('article-body')).not.toBeEmpty();

				// --- Quiz: deterministic answers → 20/32, top band.
				await page.goto(`/quiz/${QUIZ_SLUG}`);
				await pick(page, 'adormire_durata', '30-60');
				await pick(page, 'treziri', 'des');
				await pick(page, 'trezire_devreme', 'uneori');
				await pick(page, 'ore_somn', '5-6');
				await page.getByRole('button', { name: 'Înainte' }).click();
				await pickLikert(page, 'oboseala_zi', '2');
				await pickLikert(page, 'concentrare', '2');
				await pickLikert(page, 'atipiri', '2');
				await pick(page, 'impact', 'moderat');
				await page.getByRole('button', { name: 'Înainte' }).click();
				await pick(page, 'cafeina', 'uneori');
				await pick(page, 'ecrane', 'seara-de-seara');
				await pick(page, 'factori', 'program-neregulat');
				await page.getByRole('button', { name: 'Trimite răspunsurile' }).click();
				await expect(page).toHaveURL(new RegExp(`/quiz/${QUIZ_SLUG}/rezultat/[a-f0-9-]+$`));
				await expect(page.getByTestId('result-score')).toContainText('20 din 32');

				// --- Subscribe from the result page (newsletter consent ticked).
				await page.getByTestId('result-name').fill('E2E Funnel');
				await page.getByTestId('result-email').fill(visitorEmail);
				await page.getByTestId('result-consent-newsletter').check();
				await page.getByTestId('result-email-submit').click();
				await expect(page.getByTestId('result-email-sent')).toBeVisible();

				const quizLogs = await db.select().from(emailLog).where(eq(emailLog.toEmail, visitorEmail));
				expect(quizLogs.map((l) => l.template).sort()).toEqual([
					'newsletter-confirm',
					'quiz-result'
				]);
				expect(quizLogs.every((l) => l.status === 'dryrun')).toBe(true);
				const [subscriber] = await db
					.select()
					.from(subscribers)
					.where(eq(subscribers.email, visitorEmail));
				expect(subscriber.consents.newsletter?.granted).toBe(true);

				// --- Shop: product page → cart.
				await page.goto('/magazin');
				await page
					.locator(`[data-testid="product-card"][data-slug="${CEAI.slug}"] a`)
					.first()
					.click();
				await expect(page.getByTestId('product-title')).toHaveText(CEAI.name);
				await page.getByTestId('product-add-to-cart').click();
				await expect(page).toHaveURL(/\/cos$/);
				await expect(page.locator('[data-testid="cart-line"]')).toHaveCount(1);
				await expect(page.getByTestId('cart-total')).toHaveText('34,50 lei');

				// --- Checkout (mock gateway): the action 303s to the session URL.
				const checkout = await page.context().request.post('/cos?/checkout', {
					headers: { origin: baseURL!, accept: 'text/html' },
					form: {},
					maxRedirects: 0
				});
				expect(checkout.status()).toBe(303);
				const location = checkout.headers()['location'];
				expect(location).toContain('https://checkout.stripe.com/c/pay/cs_test_mock_');
				const sessionId = location.split('/').pop()!;

				// --- Signed webhook: the order lands, confirmation email dry-runs.
				const payload = JSON.stringify({
					id: `evt_funnel_${siteId}`,
					object: 'event',
					type: 'checkout.session.completed',
					data: {
						object: {
							id: sessionId,
							object: 'checkout.session',
							amount_total: CEAI.priceCents,
							currency: 'ron',
							payment_intent: `pi_funnel_${siteId}`,
							payment_status: 'paid',
							customer_details: { email: visitorEmail, name: 'E2E Funnel' },
							collected_information: {
								shipping_details: {
									name: 'E2E Funnel',
									address: {
										line1: 'Str. Somnului 7',
										city: 'București',
										postal_code: '010101',
										country: 'RO'
									}
								}
							},
							metadata: {
								cart: buildCartMetadata([
									{ productId: CEAI.id, qty: 1, priceCents: CEAI.priceCents }
								])
							}
						}
					}
				});
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

				const [order] = await db.select().from(orders).where(eq(orders.stripeSessionId, sessionId));
				expect(order.status).toBe('paid');
				expect(order.amountTotalCents).toBe(CEAI.priceCents);

				await page.goto(`/cos/succes?session_id=${sessionId}`);
				await expect(page.getByTestId('success-order')).toContainText(visitorEmail);
				await expect(page.getByTestId('cart-count')).toHaveCount(0);

				const orderLog = await db.select().from(emailLog).where(eq(emailLog.toEmail, visitorEmail));
				const confirmation = orderLog.find((l) => l.template === 'order-confirmation');
				expect(confirmation?.status).toBe('dryrun');

				// --- Chat: the widget streams the canned (mock-provider) answer.
				await page.getByTestId('chat-toggle').click();
				await expect(page.getByTestId('chat-disclaimer')).toBeVisible();
				await page.locator('input[name="chat-message"]').fill('Cum pot dormi mai bine?');
				await page.locator('form button[type="submit"]', { hasText: 'Trimite' }).click();
				await expect(
					page.locator('[data-testid="chat-message"][data-role="assistant"]').last()
				).toContainText('Pentru un somn mai bun');
			} finally {
				await db.$client.end();
			}
		});
	});
}
