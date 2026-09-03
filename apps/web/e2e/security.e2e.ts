import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createDb } from '../src/lib/db/client.ts';
import { blurhashFromPng } from '../src/lib/modules/media/blurhash.ts';
import { storageConfigFromEnv } from '../src/lib/modules/media/env.ts';
import { media } from '../src/lib/modules/media/schema.ts';
import { createStorage } from '../src/lib/modules/media/storage.ts';
import { products } from '../src/lib/modules/shop/schema.ts';
import { DEMO_PRODUCTS } from '../src/lib/modules/shop/seed-products.ts';
import { SITE_DB_NAMES, siteDatabaseUrl } from './env.ts';
import { armCspGuard, assertNoCspViolations } from './helpers.ts';

// FIX-9 (audit 2026-09-03 P0 #1 + security headers): the built app must
// (1) refuse percent-encoded /admin paths exactly like plain ones,
// (2) carry the full security-header set with the CSP ENFORCED, and
// (3) keep the checkout form-action and the blurhash placeholder working
//     under that CSP — the flows most likely to break under form-action /
//     img-src. Chat streaming, admin upload, analytics injection and the
//     shop flow are asserted violation-free in their own specs
//     (chat / media / analytics-consent / shop).

const FIXTURE_PNG = path.resolve(import.meta.dirname, '../tests/fixtures/test-image.png');

test('the percent-encoded admin-guard bypass stays closed on the built app', async ({
	request,
	baseURL
}) => {
	// Raw request — a browser would normalize %61 before sending (which is
	// exactly why the audit reproduced this with fetch, not a page).
	const encodedCsv = await request.get('/%61dmin/subscribers/export.csv', {
		maxRedirects: 0
	});
	expect(encodedCsv.status()).toBe(303);
	expect(encodedCsv.headers()['location']).toBe('/admin/login');
	expect(encodedCsv.headers()['content-type'] ?? '').not.toContain('text/csv');

	// A matching `origin` clears SvelteKit's CSRF check, so the guard's own
	// redirect (not a 403 CSRF refusal) is what this asserts — the action
	// must never run for an anonymous caller.
	const encodedAction = await request.post('/%61dmin/pages/some-id?/save', {
		headers: { accept: 'text/html', origin: baseURL! },
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

test('form-action is browser-enforced: foreign origins refused, the Stripe origin admitted', async ({
	page
}) => {
	// The checkout form posts to `/cos?/checkout` (self) and the server 303s
	// to https://checkout.stripe.com — shop.e2e.ts asserts that Location under
	// this same header. The browser side of `form-action 'self'
	// https://checkout.stripe.com` is proven here in both directions, from a
	// real page of the built app:
	//   1. a form aimed at ANY other origin is refused before a byte leaves
	//      (the property that stops an XSS-driven plain-POST off /admin);
	//   2. a form aimed at the Stripe checkout origin is admitted — the
	//      navigation is intercepted and stubbed, so real Stripe is never
	//      contacted.
	// The checkout 303 itself is not driven through the browser: Playwright
	// routes only the FIRST request of a redirect chain, so a test following
	// the redirect would hit real Stripe — which no test may do.
	const guard = await armCspGuard(page);
	let hitExternal = false;
	await page.route('https://evil.example/**', (route) => {
		hitExternal = true;
		return route.abort();
	});
	await page.route('https://checkout.stripe.com/**', (route) =>
		route.fulfill({ contentType: 'text/html', body: '<h1 data-stub>stripe-checkout</h1>' })
	);

	const submitTo = (action: string) =>
		page.evaluate((target) => {
			const form = document.createElement('form');
			form.method = 'POST';
			form.action = target;
			document.body.appendChild(form);
			form.submit();
		}, action);

	// 1. Refused pre-flight: a form-action violation fires, the document stays
	//    the cart, and no request ever reaches the disallowed origin. (Read
	//    location.href from the page rather than toHaveURL: Chromium reports
	//    the blocked submission as a navigation that never commits, which
	//    leaves Playwright's URL matcher waiting on it forever.)
	await page.goto('/cos');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
	await submitTo('https://evil.example/steal');
	await expect
		.poll(() =>
			page.evaluate(
				() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []
			)
		)
		.toContain('form-action: https://evil.example/steal');
	expect(await page.evaluate(() => location.href)).toMatch(/\/cos$/);
	expect(hitExternal).toBe(false);

	// 2. Admitted: a fresh cart page navigates to the (stubbed) Stripe origin.
	await page.goto('/cos');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
	await submitTo('https://checkout.stripe.com/c/pay/e2e-stub');
	await page.waitForURL(/checkout\.stripe\.com/);
	await expect(page.locator('[data-stub]')).toHaveText('stripe-checkout');
	// Exactly one CSP refusal happened in this test, and it was the evil one
	// (Chromium's message quotes the whole directive, so match the blocked
	// URL, not the Stripe origin).
	expect(guard.consoleErrors).toHaveLength(1);
	expect(guard.consoleErrors[0]).toContain("Sending form data to 'https://evil.example/steal'");
});

test('blurhash placeholder renders as a data: background under img-src', async ({
	page
}, testInfo) => {
	// The seeded demo covers are SVGs, which never get a placeholder, and
	// IMAGE_PROVIDER=direct computes no blurhash at upload. So give the first
	// demo product a real PNG cover (object in the bucket + media row) with a
	// blurhash from the app's own encoder — the page then serves the genuine
	// data:-URL placeholder through the normal imgSources → <Img> pipeline.
	const siteId = testInfo.project.name as keyof typeof SITE_DB_NAMES;
	const db = createDb(siteDatabaseUrl(siteId));
	const storage = createStorage(storageConfigFromEnv(process.env));
	const coverId = `e2e-blurhash-cover-${siteId}`;
	const key = `e2e/security/${siteId}/blurhash-cover.png`;
	let originalCoverId: string | null = null;
	let productId: string | null = null;
	try {
		const [product] = await db
			.select()
			.from(products)
			.where(eq(products.slug, DEMO_PRODUCTS[0].slug));
		productId = product.id;
		originalCoverId = product.coverMediaId;

		const bytes = await readFile(FIXTURE_PNG);
		const { width, height } = PNG.sync.read(bytes);
		await storage.putObject(key, bytes, 'image/png');
		const blurhash = blurhashFromPng(tinyRender(bytes));
		await db
			.insert(media)
			.values({
				id: coverId,
				kind: 'image',
				key,
				filename: 'blurhash-cover.png',
				mime: 'image/png',
				size: bytes.length,
				width,
				height,
				alt: 'Copertă cu blurhash',
				blurhash
			})
			.onConflictDoUpdate({ target: media.id, set: { key, blurhash, width, height } });
		await db.update(products).set({ coverMediaId: coverId }).where(eq(products.id, product.id));

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
			.toBe(width);
		// The placeholder is dropped by the JS-attached load listener (no inline
		// onload — the CSP would block that), so hydration + listener both ran.
		await expect(img).not.toHaveAttribute('style', /background-image/);
		await assertNoCspViolations(page, guard);
	} finally {
		if (productId) {
			await db
				.update(products)
				.set({ coverMediaId: originalCoverId })
				.where(eq(products.id, productId));
		}
		await db.delete(media).where(eq(media.id, coverId));
		await db.$client.end();
	}
});

/**
 * The encoder wants a tiny render (≤64×64 — in production the image provider
 * produces it); nearest-neighbour downscale of the fixture to 32×20 stands in
 * for that resize here.
 */
function tinyRender(pngBytes: Uint8Array): Uint8Array {
	const src = PNG.sync.read(Buffer.from(pngBytes));
	const out = new PNG({ width: 32, height: 20 });
	for (let y = 0; y < out.height; y++) {
		for (let x = 0; x < out.width; x++) {
			const sx = Math.floor((x * src.width) / out.width);
			const sy = Math.floor((y * src.height) / out.height);
			const si = (sy * src.width + sx) * 4;
			const oi = (y * out.width + x) * 4;
			out.data[oi] = src.data[si];
			out.data[oi + 1] = src.data[si + 1];
			out.data[oi + 2] = src.data[si + 2];
			out.data[oi + 3] = src.data[si + 3];
		}
	}
	return PNG.sync.write(out);
}
