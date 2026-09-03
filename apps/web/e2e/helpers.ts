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

/**
 * CSP violation tracking (FIX-9): call BEFORE the first goto. Collects every
 * `securitypolicyviolation` event plus every console error that reads like a
 * CSP refusal, so a flow test can end with `assertNoCspViolations` and prove
 * the enforced policy did not break it.
 */
export async function armCspGuard(page: Page): Promise<{ consoleErrors: string[] }> {
	const consoleErrors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) {
			consoleErrors.push(message.text());
		}
	});
	await page.addInitScript(() => {
		const w = window as unknown as { __cspViolations: string[] };
		w.__cspViolations = [];
		document.addEventListener('securitypolicyviolation', (event) => {
			w.__cspViolations.push(`${event.violatedDirective}: ${event.blockedURI || '(inline)'}`);
		});
	});
	return { consoleErrors };
}

export async function assertNoCspViolations(
	page: Page,
	guard: { consoleErrors: string[] }
): Promise<void> {
	const violations = await page.evaluate(
		() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []
	);
	expect(violations, 'securitypolicyviolation events').toEqual([]);
	expect(guard.consoleErrors, 'CSP console errors').toEqual([]);
}
