import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { E2E_ADMIN } from './env.ts';

const FIXTURE = path.resolve(import.meta.dirname, '../tests/fixtures/test-image.png');
const FIXTURE_NAME = 'test-image.png';

async function login(page: Page, credentials: { email: string; password: string }) {
	await page.goto('/admin/login');
	await page.locator('input[name="email"]').fill(credentials.email);
	await page.locator('input[name="password"]').fill(credentials.password);
	await page.locator('button[type="submit"]').click();
	await expect(page).toHaveURL(/\/admin$/);
}

test('admin uploads an image, sees its thumbnail, edits alt text, deletes it', async ({ page }) => {
	await login(page, E2E_ADMIN);
	await page.goto('/admin/media');

	// Upload through the (hidden) file input behind the drop zone.
	await page.getByTestId('media-file-input').setInputFiles(FIXTURE);
	const item = page.getByTestId('media-item').filter({ hasText: FIXTURE_NAME }).first();
	await expect(item).toBeVisible();
	await expect(page.getByTestId('media-upload-error')).toHaveCount(0);

	// The thumbnail really renders — i.e. the browser fetched a signed imgproxy
	// URL and got image bytes back (naturalWidth is 0 on a broken image).
	const img = item.locator('img');
	await expect(img).toBeVisible();
	await expect
		.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
		.toBeGreaterThan(0);
	await expect(item).toContainText('320×200');

	// Edit alt text; it survives a reload.
	await item.getByTestId('media-alt-input').fill('Un apus de test');
	await item.getByTestId('media-alt-save').click();
	await expect(item.getByTestId('media-alt-saved')).toBeVisible();
	await page.reload();
	const reloaded = page.getByTestId('media-item').filter({ hasText: FIXTURE_NAME }).first();
	await expect(reloaded.getByTestId('media-alt-input')).toHaveValue('Un apus de test');
	await expect(reloaded.locator('img')).toHaveAttribute('alt', 'Un apus de test');

	// Delete removes the card.
	await reloaded.getByTestId('media-delete').click();
	await expect(page.getByTestId('media-item').filter({ hasText: FIXTURE_NAME })).toHaveCount(0);
	await page.reload();
	await expect(page.getByTestId('media-item').filter({ hasText: FIXTURE_NAME })).toHaveCount(0);
});
