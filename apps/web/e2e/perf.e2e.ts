import { expect, test, type Page } from '@playwright/test';
import { DEMO_PRODUCTS } from '../src/lib/modules/shop/seed-products.ts';

// Performance gate: every rendered image is served by imgproxy (the storage
// endpoint never appears in HTML — originals stay private), all <img>
// elements carry width+height (no layout shift), and no external/webfont
// requests exist (the platform deliberately uses the system font stack —
// see STATE.md).

const CEAI = DEMO_PRODUCTS[1];
const PAGES = ['/', '/blog', '/magazin', `/magazin/${CEAI.slug}`, '/sanatate/somn'];

const S3_ENDPOINT = process.env.S3_ENDPOINT ?? '';
const IMGPROXY_URL = process.env.IMGPROXY_URL ?? '';
if (!S3_ENDPOINT || !IMGPROXY_URL) {
	throw new Error('S3_ENDPOINT / IMGPROXY_URL are not set — configure the root .env');
}

test('rendered HTML never links the storage endpoint directly', async ({ page }) => {
	for (const path of PAGES) {
		const res = await page.request.get(path);
		expect(res.status(), path).toBe(200);
		const html = await res.text();
		// `plain/s3://…` inside imgproxy URLs is imgproxy's server-side source
		// ref; what must never leak is a browser-reachable storage URL.
		expect(html, `${path} leaks a raw storage URL`).not.toContain(S3_ENDPOINT);
	}
});

async function auditImages(page: Page, path: string) {
	await page.goto(path);
	const images = page.locator('img');
	const count = await images.count();
	for (let i = 0; i < count; i++) {
		const img = images.nth(i);
		const [src, width, height] = await Promise.all([
			img.getAttribute('src'),
			img.getAttribute('width'),
			img.getAttribute('height')
		]);
		// Every image URL is an imgproxy URL (never a raw original)…
		expect(
			src?.startsWith(IMGPROXY_URL),
			`${path} img[${i}] (${src}) is not served by imgproxy`
		).toBe(true);
		// …with dimensions reserved → no content-image layout shift.
		expect(width, `${path} img[${i}] (${src}) lacks width`).toBeTruthy();
		expect(height, `${path} img[${i}] (${src}) lacks height`).toBeTruthy();
	}
	return count;
}

test('content images are imgproxy-served and sized (no CLS)', async ({ page }) => {
	let audited = 0;
	for (const path of PAGES) {
		audited += await auditImages(page, path);
	}
	// The catalog pages must have rendered real images, or this test proved nothing.
	expect(audited).toBeGreaterThan(3);
});

test('no external font (or any third-party) requests on the homepage', async ({ page }) => {
	const external: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.hostname !== 'localhost') external.push(request.url());
	});
	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
	expect(external, 'unexpected third-party requests (fonts, CDNs, analytics)').toEqual([]);
});
