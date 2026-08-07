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
