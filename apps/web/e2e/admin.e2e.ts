import { expect, test } from '@playwright/test';
import { E2E_ADMIN, E2E_EDITOR } from './env.ts';
import { login, submitLogin } from './helpers.ts';

test('anonymous visitors are redirected from /admin to the login page', async ({ page }) => {
	await page.goto('/admin');
	await expect(page).toHaveURL(/\/admin\/login$/);
	await page.goto('/admin/articles');
	await expect(page).toHaveURL(/\/admin\/login$/);
});

test('wrong password stays out; the 6th attempt is rate-limited', async ({ page }) => {
	// Dedicated email: the counter is keyed by IP+email, so other tests are unaffected.
	const target = { email: 'e2e-ratelimit@example.com', password: 'definitely-wrong-1' };
	for (let attempt = 1; attempt <= 5; attempt++) {
		await submitLogin(page, target);
		await expect(page.getByTestId('login-error'), `attempt ${attempt}`).toBeVisible();
		await expect(page).toHaveURL(/\/admin\/login$/);
	}
	await submitLogin(page, target);
	await expect(page.getByTestId('login-rate-limited')).toBeVisible();
	await expect(page).toHaveURL(/\/admin\/login$/);
});

test('admin logs in to the dashboard, sees the full sidebar, and can log out', async ({ page }) => {
	await login(page, E2E_ADMIN);
	await expect(page).toHaveURL(/\/admin$/);
	await expect(page.getByTestId('admin-dashboard')).toBeVisible();
	await expect(page.getByTestId('admin-sidebar')).toBeVisible();
	await expect(page.getByTestId('admin-user')).toContainText(E2E_ADMIN.email);
	// Admin sees the admin-only sections in the nav.
	for (const section of ['products', 'orders', 'subscribers', 'settings']) {
		await expect(page.getByTestId(`admin-nav-${section}`)).toBeVisible();
	}

	await page.getByTestId('admin-logout').click();
	await expect(page).toHaveURL(/\/admin\/login$/);
	// The session is really gone: /admin bounces back to login.
	await page.goto('/admin');
	await expect(page).toHaveURL(/\/admin\/login$/);
});

test('editor sees content sections only and gets 403 on admin-only routes', async ({ page }) => {
	await login(page, E2E_EDITOR);
	await expect(page).toHaveURL(/\/admin$/);
	await expect(page.getByTestId('admin-dashboard')).toBeVisible();

	// Content sections are visible, admin-only ones are hidden from the nav…
	await expect(page.getByTestId('admin-nav-articles')).toBeVisible();
	for (const section of ['products', 'orders', 'subscribers', 'settings']) {
		await expect(page.getByTestId(`admin-nav-${section}`)).toHaveCount(0);
	}

	// …and blocked server-side, not just visually.
	for (const section of ['products', 'orders', 'subscribers', 'settings']) {
		const response = await page.goto(`/admin/${section}`);
		expect(response?.status(), `/admin/${section}`).toBe(403);
	}

	// Content sections still load (articles is a real page since Phase 3).
	const articles = await page.goto('/admin/articles');
	expect(articles?.status()).toBe(200);
	await expect(page.getByTestId('article-new-title')).toBeVisible();
});
