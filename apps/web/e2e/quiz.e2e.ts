import { expect, test, type Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDb } from '../src/lib/db/client.ts';
import { emailLog } from '../src/lib/modules/email/schema.ts';
import { subscribers } from '../src/lib/modules/crm/schema.ts';
import { E2E_ADMIN, SITE_DB_NAMES, siteDatabaseUrl } from './env.ts';
import { login } from './helpers.ts';

// The full lead funnel, on BOTH sites, against the seeded sleep quiz
// (`somn` is active on sleep AND life): a visitor completes the quiz, sees
// the result on-page, leaves an email WITH newsletter consent → both emails
// land in email_log as dry-runs → the confirm link confirms, the unsubscribe
// link revokes → the admin sees the subscriber and the quiz result.

const QUIZ_SLUG = 'evaluare-somn';

/** Pick an option by question id + option value (stable against copy edits). */
async function pick(page: Page, questionId: string, value: string) {
	await page.locator(`input[name="${questionId}"][value="${value}"]`).check();
}

/** Likert inputs are sr-only — click their wrapping label instead. */
async function pickLikert(page: Page, questionId: string, value: string) {
	await page.locator(`label:has(input[name="${questionId}"][value="${value}"])`).click();
}

test('visitor completes the seeded quiz, opts into the funnel, confirms and unsubscribes; admin sees everything', async ({
	page
}, testInfo) => {
	const siteId = testInfo.project.name as keyof typeof SITE_DB_NAMES;
	const visitorEmail = `e2e-funnel@example.com`;
	const db = createDb(siteDatabaseUrl(siteId));

	try {
		await page.goto(`/quiz/${QUIZ_SLUG}`);
		await expect(page.getByRole('heading', { name: 'Evaluarea somnului' })).toBeVisible();
		await expect(page.getByTestId('quiz-intro')).toContainText('3 minute');

		// Step 1 — noapte (7 points).
		await pick(page, 'adormire_durata', '30-60');
		await pick(page, 'treziri', 'des');
		await pick(page, 'trezire_devreme', 'uneori');
		await pick(page, 'ore_somn', '5-6');
		await page.getByRole('button', { name: 'Înainte' }).click();

		// Step 2 — zi (8 points).
		await pickLikert(page, 'oboseala_zi', '2');
		await pickLikert(page, 'concentrare', '2');
		await pickLikert(page, 'atipiri', '2');
		await pick(page, 'impact', 'moderat');
		await page.getByRole('button', { name: 'Înainte' }).click();

		// Step 3 — obiceiuri (5 points) → total 20 of 32 → the top band.
		await pick(page, 'cafeina', 'uneori');
		await pick(page, 'ecrane', 'seara-de-seara');
		await pick(page, 'factori', 'program-neregulat');
		await page.getByRole('button', { name: 'Trimite răspunsurile' }).click();

		// The submit endpoint stored the result and redirected to the result page.
		await expect(page).toHaveURL(new RegExp(`/quiz/${QUIZ_SLUG}/rezultat/[a-f0-9-]+$`));
		await expect(page.getByTestId('result-band')).toHaveText('Somn afectat serios');
		await expect(page.getByTestId('result-score')).toContainText('20 din 32');
		await expect(page.locator('[data-testid="result-dimension"]')).toHaveCount(3);

		// Result pages carry personal scores (PII) — they must never be indexed.
		await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content', /noindex/);

		// GDPR: both consent checkboxes start UNTICKED; the result is already
		// fully visible without giving an email.
		await expect(page.getByTestId('result-consent-newsletter')).not.toBeChecked();
		await expect(page.getByTestId('result-consent-profile')).not.toBeChecked();

		// Leave an email with newsletter consent only.
		await page.getByTestId('result-name').fill('E2E Vizitator');
		await page.getByTestId('result-email').fill(visitorEmail);
		await page.getByTestId('result-consent-newsletter').check();
		await page.getByTestId('result-email-submit').click();
		await expect(page.getByTestId('result-email-sent')).toBeVisible();

		// email_log holds BOTH funnel emails, strictly as dry-runs.
		const logs = await db.select().from(emailLog).where(eq(emailLog.toEmail, visitorEmail));
		expect(logs.map((l) => l.template).sort()).toEqual(['newsletter-confirm', 'quiz-result']);
		expect(logs.every((l) => l.status === 'dryrun')).toBe(true);

		// The confirm link from the (dry-run) email confirms the subscription.
		const confirmUrl = (
			logs.find((l) => l.template === 'newsletter-confirm')!.data as { confirmUrl: string }
		).confirmUrl;
		const token = confirmUrl.split('/newsletter/confirm/')[1];
		await page.goto(`/newsletter/confirm/${token}`);
		await expect(page.getByTestId('confirm-success')).toBeVisible();

		const [confirmed] = await db
			.select()
			.from(subscribers)
			.where(eq(subscribers.email, visitorEmail));
		expect(confirmed.confirmedAt).not.toBeNull();
		expect(confirmed.consents.newsletter?.granted).toBe(true);
		expect(confirmed.consents.newsletter?.source).toBe(`quiz:${QUIZ_SLUG}`);
		// The profile checkbox stayed unticked → that consent was never touched.
		expect(confirmed.consents.profile_emails).toBeUndefined();

		// Admin (subscribers is an admin-only section) sees the subscriber…
		await login(page, E2E_ADMIN);
		await page.goto('/admin/subscribers');
		const row = page.locator(`[data-testid="subscriber-row"][data-email="${visitorEmail}"]`);
		await expect(row).toBeVisible();
		await expect(row.getByTestId('subscriber-newsletter')).toContainText('Da');
		await expect(row.getByTestId('subscriber-confirmed')).toContainText('Da');

		// …and the quiz result, from the quizzes screen.
		await page.goto('/admin/quizzes');
		const quizRow = page.locator(`[data-testid="quiz-row"][data-slug="${QUIZ_SLUG}"]`);
		await expect(quizRow.getByTestId('quiz-results-count')).toContainText(/[1-9]/);
		await quizRow.click();
		await expect(
			page.locator('[data-testid="quiz-result-row"]', { hasText: visitorEmail })
		).toBeVisible();
		await expect(
			page.locator('[data-testid="quiz-result-row"]', { hasText: visitorEmail })
		).toContainText('Somn afectat serios');

		// One-click unsubscribe revokes the consent.
		const [{ unsubscribeToken }] = await db
			.select()
			.from(subscribers)
			.where(eq(subscribers.email, visitorEmail));
		await page.goto(`/unsubscribe/${unsubscribeToken}`);
		await expect(page.getByTestId('unsubscribe-done')).toBeVisible();
		const [after] = await db.select().from(subscribers).where(eq(subscribers.email, visitorEmail));
		expect(after.consents.newsletter?.granted).toBe(false);
		expect(after.consents.newsletter?.source).toBe('unsubscribe');
	} finally {
		await db.$client.end();
	}
});

test('footer newsletter signup starts double opt-in from the blog', async ({ page }, testInfo) => {
	const siteId = testInfo.project.name as keyof typeof SITE_DB_NAMES;
	const email = `e2e-footer@example.com`;
	const db = createDb(siteDatabaseUrl(siteId));

	try {
		await page.goto('/blog');
		const footerForm = page.locator('footer [data-testid="newsletter-form"]');
		await expect(footerForm.getByTestId('newsletter-consent')).not.toBeChecked();
		await footerForm.getByTestId('newsletter-email').fill(email);
		await footerForm.getByTestId('newsletter-consent').check();
		await footerForm.getByTestId('newsletter-submit').click();

		await expect(page).toHaveURL(/\/newsletter$/);
		await expect(page.getByTestId('newsletter-status-sent')).toBeVisible();

		const logs = await db.select().from(emailLog).where(eq(emailLog.toEmail, email));
		expect(logs).toHaveLength(1);
		expect(logs[0].template).toBe('newsletter-confirm');
		expect(logs[0].status).toBe('dryrun');
		const [subscriber] = await db.select().from(subscribers).where(eq(subscribers.email, email));
		expect(subscriber.consents.newsletter?.source).toBe('footer');
	} finally {
		await db.$client.end();
	}
});
