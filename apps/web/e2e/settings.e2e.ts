import { expect, test } from '@playwright/test';
import { E2E_ADMIN } from './env.ts';
import { login } from './helpers.ts';

// Editor-role access is covered in admin.e2e.ts: /admin/settings answers 403
// and the sidebar entry is hidden (settings is in ADMIN_ONLY_SECTIONS).

test('admin saves company identification; values persist after reload', async ({ page }) => {
	await login(page, E2E_ADMIN);
	await page.goto('/admin/settings');
	// Inputs carry server-echoed values — typing before hydration races.
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');

	await page.getByTestId('settings-field-company.legalName').fill('E2E Exemplu SRL');
	await page.getByTestId('settings-field-company.cui').fill('RO12345678');
	await page.getByTestId('settings-field-company.regCom').fill('J40/1234/2024');
	await page.getByTestId('settings-field-company.address').fill('Str. Exemplu 1, București');
	await page.getByTestId('settings-field-company.contactEmail').fill('contact@exemplu.ro');
	await page.getByTestId('settings-field-company.contactPhone').fill('+40 700 000 000');
	await page.getByTestId('settings-field-company.vatRegistered').check();
	await page.getByTestId('settings-save-company').click();

	await expect(page.getByTestId('settings-saved')).toBeVisible();
	await expect(page.getByTestId('settings-audit')).toContainText(E2E_ADMIN.email);

	await page.reload();
	await expect(page.getByTestId('settings-field-company.legalName')).toHaveValue('E2E Exemplu SRL');
	await expect(page.getByTestId('settings-field-company.vatRegistered')).toBeChecked();
});

test('invalid input shows a field error and persists nothing', async ({ page }) => {
	await login(page, E2E_ADMIN);
	await page.goto('/admin/settings');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');

	await page.getByTestId('settings-field-company.cui').fill('not-a-cui');
	await page.getByTestId('settings-save-company').click();

	await expect(page.getByTestId('settings-error-company.cui')).toBeVisible();
	// The previous test's valid save survives the refused one.
	await page.reload();
	await expect(page.getByTestId('settings-field-company.cui')).toHaveValue('RO12345678');
});

// Depends on the company data saved by the first test (tests in this file run
// in order); lives here so no parallel spec races the shared site_settings.
test('saved identification + ANPC links render in the footer and on legal pages', async ({
	page
}) => {
	await login(page, E2E_ADMIN);
	await page.goto('/admin/settings');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
	await page.getByTestId('settings-field-legal.anpcSalUrl').fill('https://anpc.ro/ce-este-sal/');
	await page
		.getByTestId('settings-field-legal.anpcSolUrl')
		.fill('https://ec.europa.eu/consumers/odr');
	await page.getByTestId('settings-save-legal').click();
	await expect(page.getByTestId('settings-saved')).toBeVisible();

	// Footer, on every public page — home and a legal page as witnesses.
	await page.goto('/');
	const footer = page.getByTestId('legal-identity');
	await expect(footer.getByTestId('legal-identity-name')).toHaveText('E2E Exemplu SRL');
	// VAT-registered ⇒ the CUI carries the RO prefix.
	await expect(footer.getByTestId('legal-identity-cui')).toContainText('RO12345678');
	await expect(footer.getByTestId('legal-identity-regcom')).toContainText('J40/1234/2024');
	await expect(footer.getByTestId('legal-identity-address')).toContainText('Str. Exemplu 1');
	await expect(footer.getByTestId('legal-identity-email')).toContainText('contact@exemplu.ro');
	const sal = footer.getByTestId('legal-anpc-sal');
	await expect(sal).toHaveAttribute('href', 'https://anpc.ro/ce-este-sal/');
	await expect(sal).toHaveAttribute('rel', 'noopener');
	await expect(footer.getByTestId('legal-anpc-sol')).toHaveAttribute(
		'href',
		'https://ec.europa.eu/consumers/odr'
	);

	// Legal pages carry the identification block above the lawyer-editable prose.
	await page.goto('/pagini/politica-de-confidentialitate');
	await expect(
		page.getByTestId('legal-page-identity').getByTestId('legal-identity-name')
	).toHaveText('E2E Exemplu SRL');
	await page.goto('/pagini/termeni-si-conditii');
	await expect(
		page.getByTestId('legal-page-identity').getByTestId('legal-identity-cui')
	).toContainText('RO12345678');

	// The cookie policy lists the real cookie inventory and links from the footer.
	await page.goto('/');
	await page.getByRole('link', { name: 'Politica de cookie-uri' }).click();
	await expect(page.getByTestId('cookie-table')).toBeVisible();
	for (const name of ['better-auth.session_token', 'cart', 'cookie_consent', 'chat_session']) {
		await expect(page.getByTestId('cookie-table')).toContainText(name);
	}
	await expect(page.getByTestId('consent-manager')).toBeVisible();
});
