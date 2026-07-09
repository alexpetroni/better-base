import { expect, type Page } from '@playwright/test';

/**
 * Fills and submits the login form without asserting the outcome (the
 * rate-limit test submits wrong credentials on purpose). Waits for hydration
 * first: inputs with a server-echoed `value` (the email field) are reset when
 * the component hydrates, so filling them earlier races and loses the value.
 */
export async function submitLogin(page: Page, credentials: { email: string; password: string }) {
	await page.goto('/admin/login');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
	await page.locator('input[name="email"]').fill(credentials.email);
	await page.locator('input[name="password"]').fill(credentials.password);
	await page.locator('button[type="submit"]').click();
}

/** Signs a staff user in and asserts the dashboard redirect. */
export async function login(page: Page, credentials: { email: string; password: string }) {
	await submitLogin(page, credentials);
	await expect(page).toHaveURL(/\/admin$/);
}
