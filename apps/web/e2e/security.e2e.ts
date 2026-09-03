import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/db/client.ts';
import { media } from '../src/lib/modules/media/schema.ts';
import { products } from '../src/lib/modules/shop/schema.ts';
import { DEMO_PRODUCTS } from '../src/lib/modules/shop/seed-products.ts';
import { SITE_DB_NAMES, siteDatabaseUrl } from './env.ts';
import { armCspGuard, assertNoCspViolations } from './helpers.ts';

// FIX-9 (audit 2026-09-03 P0 #1 + security headers): the built app must
// (1) refuse percent-encoded /admin paths exactly like plain ones,
// (2) carry the full security-header set with the CSP ENFORCED, and
// (3) keep the checkout redirect and the blurhash placeholder working under
//     that CSP — the flows most likely to break under form-action/img-src.
// Chat streaming, admin upload and analytics injection are asserted
// violation-free in their own specs (chat/media/analytics-consent).

test('the percent-encoded admin-guard bypass stays closed on the built app', async ({
	request
}) => {
	// Raw request — a browser would normalize %61 before sending (which is
	// exactly why the audit reproduced this with fetch, not a page).
	const encodedCsv = await request.get('/%61dmin/subscribers/export.csv', {
		maxRedirects: 0
	});
	expect(encodedCsv.status()).toBe(303);
	expect(encodedCsv.headers()['location']).toBe('/admin/login');
	expect(encodedCsv.headers()['content-type'] ?? '').not.toContain('text/csv');

	const encodedAction = await request.post('/%61dmin/pages/some-id?/save', {
		headers: { accept: 'text/html' },
		form: { title: 'x', bodyMd: 'y' },
		maxRedirects: 0
	});
	expect(encodedAction.status()).toBe(303);
	expect(encodedAction.headers()['location']).toBe('/admin/login');

	// The plain path keeps behaving exactly as before.
	const plain = await request.get('/admin/subscribers/export.csv', { maxRedirects: 0 });
	expect(plain.status()).toBe(303);
	expect(plain.headers()['location']).toBe('/admin/login');
});

test('every security header ships, CSP enforced, admin no-store', async ({ request }) => {
	const home = await request.get('/');
	const homeHeaders = home.headers();
	expect(homeHeaders['x-content-type-options']).toBe('nosniff');
	expect(homeHeaders['referrer-policy']).toBe('strict-origin-when-cross-origin');
	expect(homeHeaders['x-frame-options']).toBe('DENY');
	expect(homeHeaders['permissions-policy']).toContain('camera=()');

	// ENFORCED header (not report-only), static half AND runtime half present.
	const csp = homeHeaders['content-security-policy'] ?? '';
	expect(homeHeaders['content-security-policy-report-only']).toBeUndefined();
	expect(csp).toContain("'strict-dynamic'");
	expect(csp).toMatch(/style-src [^;]*'unsafe-inline'/);
	expect(csp).toContain("object-src 'none'");
	expect(csp).toContain("base-uri 'self'");
	expect(csp).toMatch(/img-src [^;]*data:/);
	expect(csp).toContain("form-action 'self' https://checkout.stripe.com");
	expect(csp).toContain("frame-ancestors 'none'");
	expect(csp).toContain('frame-src https://www.youtube-nocookie.com');

	const admin = await request.get('/admin/login');
	expect(admin.headers()['cache-control']).toBe('private, no-store');
	// Public pages are not forced to no-store by the hook.
	expect(homeHeaders['cache-control'] ?? '').not.toContain('no-store');
});

test('checkout form post redirects to Stripe under the enforced form-action', async ({ page }) => {
	const guard = await armCspGuard(page);
	// The mock gateway 303s to a checkout.stripe.com URL; intercept it so the
	// browser NAVIGATES there (Chrome enforces form-action on that redirect)
	// without the test ever leaving localhost.
	await page.route('https://checkout.stripe.com/**', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<h1 data-stub>stripe-checkout</h1>' })
	);

	await page.goto(`/magazin/${DEMO_PRODUCTS[0].slug}`);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
	await page.getByTestId('product-add-to-cart').click();
	await expect(page).toHaveURL(/\/cos$/);

	await page.getByTestId('cart-checkout').click();
	// A blocked form-action would leave the browser on /cos with a violation.
	await page.waitForURL(/checkout\.stripe\.com/);
	await expect(page.locator('[data-stub]')).toHaveText('stripe-checkout');
	await assertNoCspViolations(page, guard);
});

test('blurhash placeholder renders as a data: background under img-src', async ({
	page
}, testInfo) => {
	// IMAGE_PROVIDER=direct computes no blurhash at upload, so give the seeded
	// demo cover a real one — the page then serves the genuine data:-URL
	// placeholder through the app's own pipeline.
	const siteId = testInfo.project.name as keyof typeof SITE_DB_NAMES;
	const db = createDb(siteDatabaseUrl(siteId));
	try {
		const [product] = await db
			.select()
			.from(products)
			.where(eq(products.slug, DEMO_PRODUCTS[0].slug));
		expect(product.coverMediaId).toBeTruthy();
		await db
			.update(media)
			.set({ blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj' })
			.where(eq(media.id, product.coverMediaId!));

		// The SSR HTML really carries the data:-URL placeholder (the browser
		// drops it from the live DOM as soon as the full image loads, so the
		// attribute itself cannot be asserted race-free on the page).
		const html = await (await page.request.get('/magazin')).text();
		expect(html).toContain('background-image: url(data:image/png;base64');

		const guard = await armCspGuard(page);
		await page.goto('/magazin');
		const card = page.locator(`[data-testid="product-card"][data-slug="${product.slug}"]`);
		const img = card.locator('img');
		await expect
			.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
			.toBeGreaterThan(0);
		await assertNoCspViolations(page, guard);
	} finally {
		await db.$client.end();
	}
});
