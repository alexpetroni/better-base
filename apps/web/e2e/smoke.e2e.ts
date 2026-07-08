import { expect, test } from '@playwright/test';
import { sleepSite } from '../src/lib/config/sites/sleep.ts';
import { lifeSite } from '../src/lib/config/sites/life.ts';

// The playwright project name ('sleep' | 'life') selects which preview server
// (and therefore which SITE_ID) a test run targets — see playwright.config.ts.
function siteFor(projectName: string) {
	if (projectName === 'sleep') return sleepSite;
	if (projectName === 'life') return lifeSite;
	throw new Error(`Unknown playwright project "${projectName}"`);
}

test('homepage shows the site name and exactly the active pillars', async ({ page }, testInfo) => {
	const site = siteFor(testInfo.project.name);
	await page.goto('/');
	await expect(page.locator('header')).toContainText(site.name);
	await expect(page.getByTestId('pillar-item')).toHaveCount(site.pillars.length);
});

test('an active pillar has a landing page', async ({ page }, testInfo) => {
	const site = siteFor(testInfo.project.name);
	const slug = site.pillars[0];
	await page.goto(`/sanatate/${slug}`);
	await expect(page.getByTestId('pillar-title')).toBeVisible();
});

test('an unknown pillar renders the 404 page', async ({ page }) => {
	const response = await page.goto('/sanatate/nu-exista');
	expect(response?.status()).toBe(404);
	await expect(page.locator('h1')).toContainText('404');
});

test('an inactive canonical pillar 404s on the sleep site', async ({ page }, testInfo) => {
	test.skip(testInfo.project.name !== 'sleep', 'only meaningful where a pillar is inactive');
	const response = await page.goto('/sanatate/finante');
	expect(response?.status()).toBe(404);
});
