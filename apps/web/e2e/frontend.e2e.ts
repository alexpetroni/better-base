import { expect, test } from '@playwright/test';

// FIX-8 behavioral frontend gate: real SEO metadata on the home page,
// hreflang alternates, double-submit protection on public forms and the
// cookie banner not occluding the chat widget on mobile. Runs on both sites.

test('home page ships full SEO metadata and hreflang alternates', async ({ page }) => {
	await page.goto('/');

	const head = page.locator('head');
	await expect(head.locator('meta[name="description"]')).toHaveAttribute('content', /.+/);
	await expect(head.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/$/);
	await expect(head.locator('meta[property="og:title"]')).toHaveAttribute('content', /.+/);
	await expect(head.locator('meta[property="og:type"]')).toHaveAttribute('content', 'website');

	// hreflang: one alternate per locale + x-default, as real <link> tags
	// (the old display:none anchor hack advertised nothing to crawlers).
	await expect(head.locator('link[rel="alternate"][hreflang="ro"]')).toHaveCount(1);
	await expect(head.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute(
		'href',
		/\/en\/?$/
	);
	await expect(head.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveCount(1);
});

test('newsletter submit disables while the POST is in flight (no double-submit)', async ({
	page
}) => {
	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');

	// The POST navigates away and page.click() only returns AFTER that
	// navigation commits (by then the next page's footer shows a fresh,
	// enabled button) — so record the state at submit time from inside the
	// page. The probe listener registers after the guard's (hydration ran
	// first), and sessionStorage survives the navigation.
	await page.evaluate(() => {
		const form = document.querySelector('[data-testid="newsletter-form"]');
		form?.addEventListener('submit', () => {
			const button = document.querySelector<HTMLButtonElement>('[data-testid="newsletter-submit"]');
			sessionStorage.setItem('e2e-submit-disabled', String(button?.disabled));
		});
	});

	await page.getByTestId('newsletter-email').fill('double-submit@example.com');
	await page.getByTestId('newsletter-consent').check();
	await page.getByTestId('newsletter-submit').click();
	await page.waitForURL(/\/newsletter$/);

	// Pre-fix the button stayed enabled during submission → recorded "false".
	expect(await page.evaluate(() => sessionStorage.getItem('e2e-submit-disabled'))).toBe('true');
});

test.describe('mobile viewport', () => {
	test.use({ viewport: { width: 375, height: 667 } });

	test('cookie banner does not occlude the chat widget', async ({ page }) => {
		await page.context().clearCookies(); // banner must be open for this test
		await page.goto('/');
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
		await expect(page.getByTestId('cookie-consent')).toBeVisible();

		// Pre-fix both were fixed bottom z-50 and the banner swallowed the click.
		await page.getByTestId('chat-toggle').click();
		await expect(page.getByTestId('chat-panel')).toBeVisible();
	});
});
