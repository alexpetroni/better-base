import { expect, test, type Page } from '@playwright/test';
import { E2E_ADMIN } from './env.ts';
import { login } from './helpers.ts';

// Consent-gated analytics, end-to-end. PUBLIC_ANALYTICS_* points at the
// app's OWN origin (playwright.config.ts), so the provider script URL never
// leaves localhost; here we intercept it with a stub that phones home to a
// same-origin endpoint we also intercept — proving when the script loads AND
// that a loaded script's requests stop after revocation.

const SCRIPT_PATH = '**/js/script.js';
const EVENT_PATH = '**/e2e-analytics/event';
const SCRIPT_STUB = `fetch('/e2e-analytics/event', { method: 'POST', body: location.pathname });`;

interface Counters {
	script: number;
	event: number;
}

async function armAnalyticsRoutes(page: Page): Promise<Counters> {
	const counters: Counters = { script: 0, event: 0 };
	await page.route(SCRIPT_PATH, (route) => {
		counters.script += 1;
		return route.fulfill({ contentType: 'text/javascript', body: SCRIPT_STUB });
	});
	await page.route(EVENT_PATH, (route) => {
		counters.event += 1;
		return route.fulfill({ status: 202, body: '' });
	});
	return counters;
}

// Every test exercises the banner from scratch — no pre-dismissed consent.
test.use({ storageState: { cookies: [], origins: [] } });

test('first visit: banner links the cookie policy; refusing loads nothing', async ({ page }) => {
	const counters = await armAnalyticsRoutes(page);
	await page.goto('/');
	// The banner's buttons only work once hydrated (repo-wide e2e gotcha).
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');

	const banner = page.getByTestId('cookie-consent');
	await expect(banner).toBeVisible();
	await expect(banner.locator('a')).toHaveAttribute('href', /politica-de-cookie-uri/);

	await page.getByTestId('consent-deny').click();
	await expect(banner).toBeHidden();

	// Navigation after the refusal must not load the script either.
	await page.goto('/blog');
	await expect(page.locator('script[data-analytics]')).toHaveCount(0);
	expect(counters.script).toBe(0);
	expect(counters.event).toBe(0);
});

test('accepting injects exactly one script tag and the analytics request fires once', async ({
	page
}) => {
	const counters = await armAnalyticsRoutes(page);
	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
	await expect(page.locator('script[data-analytics]')).toHaveCount(0);

	await page.getByTestId('consent-accept').click();

	// The loader reacts to the banner decision without a reload.
	await expect(page.locator('script[data-analytics="plausible"]')).toHaveCount(1);
	await expect.poll(() => counters.event).toBe(1);
	expect(counters.script).toBe(1);

	// The decision persists: a reload still carries exactly one tag.
	await page.reload();
	await expect(page.locator('script[data-analytics="plausible"]')).toHaveCount(1);
	await expect.poll(() => counters.event).toBe(2);
});

test('revoking on the cookie-policy page stops analytics for good', async ({ page }) => {
	const counters = await armAnalyticsRoutes(page);
	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
	await page.getByTestId('consent-accept').click();
	await expect.poll(() => counters.event).toBe(1);

	await page.goto('/pagini/politica-de-cookie-uri');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
	await expect(page.getByTestId('cookie-table')).toBeVisible();
	await expect.poll(() => counters.event).toBe(2);

	await page.getByTestId('consent-manager-revoke').click();
	// The manager reloads the page so the already-executed script is gone.
	await expect(page.getByTestId('consent-manager-revoke')).toBeDisabled();
	await expect(page.locator('script[data-analytics]')).toHaveCount(0);

	const afterRevocation = { ...counters };
	await page.goto('/');
	await expect(page.getByTestId('cookie-consent')).toBeHidden();
	await expect(page.locator('script[data-analytics]')).toHaveCount(0);
	expect(counters.script).toBe(afterRevocation.script);
	expect(counters.event).toBe(afterRevocation.event);

	const cookies = await page.context().cookies();
	expect(cookies.find((cookie) => cookie.name === 'cookie_consent')?.value).toBe('denied');
});

test('admin routes never load the script, even with granted consent', async ({ page }) => {
	const counters = await armAnalyticsRoutes(page);
	await page.context().addCookies([
		{
			name: 'cookie_consent',
			value: 'granted',
			domain: 'localhost',
			path: '/',
			sameSite: 'Lax'
		}
	]);
	await login(page, E2E_ADMIN);
	await expect(page.locator('script[data-analytics]')).toHaveCount(0);
	expect(counters.script).toBe(0);
	expect(counters.event).toBe(0);
});
