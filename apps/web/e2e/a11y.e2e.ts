import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DEMO_PRODUCTS } from '../src/lib/modules/shop/seed-products.ts';

// Accessibility gate (DoD): zero serious/critical axe violations on the
// customer-facing pages. Runs on both site projects.

const CEAI = DEMO_PRODUCTS[1];

async function expectNoSeriousViolations(page: Page, context: string) {
	const results = await new AxeBuilder({ page }).analyze();
	const serious = results.violations.filter(
		(v) => v.impact === 'serious' || v.impact === 'critical'
	);
	expect(
		serious.map((v) => ({
			id: v.id,
			impact: v.impact,
			help: v.help,
			nodes: v.nodes.slice(0, 3).map((n) => n.html)
		})),
		`serious/critical axe violations on ${context}`
	).toEqual([]);
}

async function gotoHydrated(page: Page, path: string) {
	await page.goto(path);
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}

test('home (incl. cookie banner) has no serious a11y violations', async ({ page }) => {
	await page.context().clearCookies(); // the consent banner must be audited too
	await gotoHydrated(page, '/');
	await expect(page.getByTestId('cookie-consent')).toBeVisible();
	await expectNoSeriousViolations(page, '/');
});

test('blog list and article have no serious a11y violations', async ({ page }) => {
	await gotoHydrated(page, '/blog');
	await expectNoSeriousViolations(page, '/blog');

	const firstCard = page.locator('[data-testid="blog-card"] a').first();
	await firstCard.click();
	await expect(page.getByTestId('article-title')).toBeVisible();
	await expectNoSeriousViolations(page, '/blog/[first article]');
});

test('quiz has no serious a11y violations', async ({ page }) => {
	await gotoHydrated(page, '/quiz/evaluare-somn');
	await expect(page.locator('form').first()).toBeVisible();
	await expectNoSeriousViolations(page, '/quiz/evaluare-somn');
});

test('product page and cart have no serious a11y violations', async ({ page }) => {
	await gotoHydrated(page, `/magazin/${CEAI.slug}`);
	await expectNoSeriousViolations(page, `/magazin/${CEAI.slug}`);

	await page.getByTestId('product-add-to-cart').click();
	await expect(page).toHaveURL(/\/cos$/);
	await expectNoSeriousViolations(page, '/cos (with one line)');
});

test('chat page and open widget have no serious a11y violations', async ({ page }) => {
	await gotoHydrated(page, '/asistent');
	await expectNoSeriousViolations(page, '/asistent');

	await gotoHydrated(page, '/');
	await page.getByTestId('chat-toggle').click();
	await expect(page.getByTestId('chat-panel')).toBeVisible();
	await expectNoSeriousViolations(page, 'floating chat widget (open)');
});
