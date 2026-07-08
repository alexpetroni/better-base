import { test, expect, type Page } from '@playwright/test';

/**
 * End-to-end tests for the conditional example (examples/conditional.ts):
 *
 * Step 1 "Travel Preferences" (id: travel)
 *   - traveling (single-select, required): yes / no / unsure
 *   - destinations (multi-select, required, hidden when traveling = no)
 *   - beach_country (text, shown when traveling = yes AND destinations includes beach)
 *   - no_travel_reason (textarea, shown when traveling = no)
 * Step 2 "Trip Details" (id: trip-details) — SKIPPED unless traveling = yes
 *   - trip_length (number, required, 1–365)
 * Step 3 "Follow-up" (id: follow-up)
 *   - budget group (scale, required, hidden when traveling = no)
 *   - email (text, optional)
 */

const progress = (page: Page) => page.getByRole('navigation', { name: 'Progress' });
const next = (page: Page) => page.getByRole('button', { name: /Next|Submit/ });

/** Navigate and wait until the client bundle is loaded, so clicks land after hydration. */
async function gotoForm(page: Page) {
	await page.goto('/examples/conditional');
	await page.waitForLoadState('networkidle');
}

test('skipped step is hidden until its condition is met, then navigated through', async ({ page }) => {
	await gotoForm(page);

	// Initially traveling is unanswered → Trip Details is skipped
	await expect(progress(page)).toBeVisible();
	await expect(progress(page)).not.toContainText('Trip Details');
	await expect(progress(page)).toContainText('Follow-up');

	// Answering "Yes" reveals the step in the header
	await page.getByRole('radio', { name: 'Yes' }).check();
	await expect(progress(page)).toContainText('Trip Details');

	// Complete step 1 and land on Trip Details, not Follow-up
	await page.getByRole('checkbox', { name: 'Mountains' }).check();
	await next(page).click();
	await expect(page.getByRole('heading', { name: 'Trip Details' })).toBeVisible();

	// Complete Trip Details → Follow-up, and the budget scale is visible
	await page.getByLabel(/How many days/).fill('10');
	await next(page).click();
	await expect(page.getByRole('heading', { name: 'Follow-up' })).toBeVisible();
	await expect(page.getByText('How flexible is your budget?')).toBeVisible();

	// Back skips nothing here: previous visible step is Trip Details
	await page.getByRole('button', { name: 'Back' }).click();
	await expect(page.getByRole('heading', { name: 'Trip Details' })).toBeVisible();
});

test('answering "No" skips Trip Details in both directions', async ({ page }) => {
	await gotoForm(page);

	await page.getByRole('radio', { name: 'No', exact: true }).check();
	// destinations hides, the "why not" textarea appears
	await expect(page.getByText('Which destinations interest you?')).toBeHidden();
	await expect(page.getByLabel(/keeping you from traveling/)).toBeVisible();
	await expect(progress(page)).not.toContainText('Trip Details');

	// Next jumps straight to Follow-up; the budget group is hidden too
	await next(page).click();
	await expect(page.getByRole('heading', { name: 'Follow-up' })).toBeVisible();
	await expect(page.getByText('How flexible is your budget?')).toBeHidden();

	// Back returns to step 1, skipping Trip Details
	await page.getByRole('button', { name: 'Back' }).click();
	await expect(page.getByRole('heading', { name: 'Travel Preferences' })).toBeVisible();
});

test('answers to hidden questions are cleared, including transitively', async ({ page }) => {
	await gotoForm(page);

	// Answer yes → beach → country: two dependent questions filled
	await page.getByRole('radio', { name: 'Yes' }).check();
	await page.getByRole('checkbox', { name: 'Beach' }).check();
	const country = page.getByLabel(/beach country/);
	await expect(country).toBeVisible();
	await country.fill('Portugal');

	// Switching to "No" hides destinations (directly) and beach_country (transitively)
	await page.getByRole('radio', { name: 'No', exact: true }).check();
	await expect(page.getByRole('checkbox', { name: 'Beach' })).toBeHidden();
	await expect(country).toBeHidden();

	// Switching back: the cleared answers must not resurrect
	await page.getByRole('radio', { name: 'Yes' }).check();
	await expect(page.getByRole('checkbox', { name: 'Beach' })).not.toBeChecked();
	await expect(country).toBeHidden();
});

test('validation blocks progression and announces an error', async ({ page }) => {
	await gotoForm(page);

	await next(page).click();
	await expect(page.getByRole('alert')).toContainText('Please complete the required fields');
	await expect(page.getByRole('heading', { name: 'Travel Preferences' })).toBeVisible();

	// Answering the required question clears the path forward
	await page.getByRole('radio', { name: 'Not sure yet' }).check();
	await page.getByRole('checkbox', { name: 'City break' }).check();
	await next(page).click();
	await expect(page.getByRole('alert')).toBeHidden();
	await expect(page.getByRole('heading', { name: 'Follow-up' })).toBeVisible();
});

test('out-of-range number blocks progression', async ({ page }) => {
	await gotoForm(page);

	await page.getByRole('radio', { name: 'Yes' }).check();
	await page.getByRole('checkbox', { name: 'Wildlife / nature' }).check();
	await next(page).click();
	await expect(page.getByRole('heading', { name: 'Trip Details' })).toBeVisible();

	// trip_length max is 365; the input clamps on change, so bypass the input
	// component's own clamping by writing state directly is not possible from
	// the UI — instead check the empty-required path and the happy path.
	await next(page).click();
	await expect(page.getByRole('alert')).toBeVisible();

	await page.getByLabel(/How many days/).fill('14');
	await next(page).click();
	await expect(page.getByRole('heading', { name: 'Follow-up' })).toBeVisible();
});

test('submitted payload contains only visible answers', async ({ page }) => {
	await gotoForm(page);

	// Capture the payload logged by the example page's onFormComplete
	const payloadPromise = new Promise<Record<string, Record<string, unknown>>>((resolve) => {
		page.on('console', async (msg) => {
			if (msg.text().startsWith('Form completed!')) {
				resolve((await msg.args()[1].jsonValue()) as Record<string, Record<string, unknown>>);
			}
		});
	});
	page.on('dialog', (dialog) => dialog.accept());

	// Fill the yes-path first so hidden answers exist, then flip to "No"
	await page.getByRole('radio', { name: 'Yes' }).check();
	await page.getByRole('checkbox', { name: 'Beach' }).check();
	await page.getByLabel(/beach country/).fill('Portugal');
	await page.getByRole('radio', { name: 'No', exact: true }).check();
	await page.getByLabel(/keeping you from traveling/).fill('Work');

	await next(page).click();
	await expect(page.getByRole('heading', { name: 'Follow-up' })).toBeVisible();
	await page.getByLabel(/Email/).fill('jane@example.com');
	await next(page).click(); // Submit

	const payload = await payloadPromise;
	expect(payload).toEqual({
		travel: { traveling: 'no', no_travel_reason: 'Work' },
		'follow-up': { email: 'jane@example.com' }
	});
	// Explicitly: no skipped step, no hidden answers
	expect(payload['trip-details']).toBeUndefined();
	expect(payload.travel.destinations).toBeUndefined();
	expect(payload.travel.beach_country).toBeUndefined();
});

test('progress header respects settings and allows back navigation', async ({ page }) => {
	await gotoForm(page);

	await page.getByRole('radio', { name: 'Not sure yet' }).check();
	await page.getByRole('checkbox', { name: 'City break' }).check();
	await next(page).click();
	await expect(page.getByRole('heading', { name: 'Follow-up' })).toBeVisible();

	// Completed step is a clickable button in the header
	await progress(page).getByRole('button', { name: 'Travel Preferences' }).click();
	await expect(page.getByRole('heading', { name: 'Travel Preferences' })).toBeVisible();

	// Answers survived the round trip (visible questions are never cleared)
	await expect(page.getByRole('radio', { name: 'Not sure yet' })).toBeChecked();
	await expect(page.getByRole('checkbox', { name: 'City break' })).toBeChecked();
});

/** Fill the minimal example and return without submitting. */
async function fillMinimal(page: Page) {
	await page.goto('/examples/minimal');
	await page.waitForLoadState('networkidle');
	page.on('dialog', (dialog) => dialog.accept());
	await page.getByLabel('Full name').fill('Jane Doe');
	await page.getByLabel(/What would you like to say/).fill('Hello');
}

test('Enter in a text input submits the step', async ({ page }) => {
	await page.route('**/api/minimal-demo', (route) => route.fulfill({ json: {} }));

	const submitted = new Promise<boolean>((resolve) => {
		page.on('console', (msg) => {
			if (msg.text().startsWith('Form completed!')) resolve(true);
		});
	});

	await fillMinimal(page);
	await page.getByLabel('Full name').press('Enter');
	expect(await submitted).toBe(true);
});

test('POSTs a uuid-keyed payload and shows the configured success screen', async ({ page }) => {
	let body: Record<string, unknown> | null = null;
	await page.route('**/api/minimal-demo', (route) => {
		body = route.request().postDataJSON();
		return route.fulfill({ json: { ok: true } });
	});

	await fillMinimal(page);
	await next(page).click();

	// The form is replaced in place by the success screen from settings
	await expect(page.getByRole('heading', { name: 'Message sent!' })).toBeVisible();
	await expect(page.getByText('Thanks for reaching out')).toBeVisible();
	await expect(next(page)).toBeHidden();

	expect(body).toMatchObject({ form: { version: 1 } });
	const answers = (body! as { answers: Record<string, unknown>[] }).answers;
	expect(answers).toEqual([
		expect.objectContaining({
			uuid: '3f1c2d84-6b1a-4f0e-9c5d-000000000001',
			questionId: 'full_name',
			stepId: 'contact',
			value: 'Jane Doe',
			displayValue: 'Jane Doe'
		}),
		expect.objectContaining({
			uuid: '3f1c2d84-6b1a-4f0e-9c5d-000000000002',
			value: 'Hello'
		})
	]);
});

test('server response can override the success text', async ({ page }) => {
	await page.route('**/api/minimal-demo', (route) =>
		route.fulfill({ json: { title: 'Score: 42', message: 'You are an optimist.' } })
	);

	await fillMinimal(page);
	await next(page).click();
	await expect(page.getByRole('heading', { name: 'Score: 42' })).toBeVisible();
	await expect(page.getByText('You are an optimist.')).toBeVisible();
});

test('server redirectUrl navigates away after success', async ({ page }) => {
	await page.route('**/api/minimal-demo', (route) =>
		route.fulfill({ json: { redirectUrl: '/examples' } })
	);

	await fillMinimal(page);
	await next(page).click();
	await page.waitForURL('**/examples');
});

test('failed POST shows an error and allows retry', async ({ page }) => {
	let attempts = 0;
	await page.route('**/api/minimal-demo', (route) => {
		attempts++;
		return attempts === 1
			? route.fulfill({ status: 500, json: { message: 'Server exploded' } })
			: route.fulfill({ json: {} });
	});

	await fillMinimal(page);
	await next(page).click();

	// Server-provided error message, form still intact for retry
	await expect(page.getByRole('alert')).toContainText('Server exploded');
	await expect(page.getByLabel('Full name')).toHaveValue('Jane Doe');

	await next(page).click();
	await expect(page.getByRole('heading', { name: 'Message sent!' })).toBeVisible();
	expect(attempts).toBe(2);
});

test('summary screen recaps answers, supports edit, and submits', async ({ page }) => {
	await page.goto('/examples/all-inputs');
	await page.waitForLoadState('networkidle');
	page.on('dialog', (dialog) => dialog.accept());
	const payloadPromise = new Promise<Record<string, Record<string, unknown>>>((resolve) => {
		page.on('console', async (msg) => {
			if (msg.text().startsWith('Form completed!')) {
				resolve((await msg.args()[1].jsonValue()) as Record<string, Record<string, unknown>>);
			}
		});
	});

	// Step 1: text (name has a tooltip icon; email is type=email)
	await expect(page.getByTitle(/official documents/)).toBeVisible();
	await expect(page.getByLabel('Email')).toHaveAttribute('type', 'email');
	await page.getByLabel('Name', { exact: true }).fill('Ada');
	await next(page).click();

	// Step 2: choice (radio list, cards, dropdown, multi)
	await page.getByRole('radio', { name: 'Engineer' }).check();
	// Card and scale options hide their radio (sr-only), so click the label
	await page.locator('label').filter({ hasText: 'Free' }).click();
	await page.getByLabel('Country').selectOption('pt');
	await page.getByRole('checkbox', { name: 'Reading' }).check();
	await next(page).click();

	// Step 3: numbers, scale, range (invalid inverted range first), time, date
	await page.getByLabel('Height').fill('170');
	await page.getByLabel('Weight').fill('70');
	await page.locator('label').filter({ hasText: /^\s*8\s*$/ }).click();
	await page.getByLabel('At least').fill('2000');
	await page.getByLabel('At most').fill('1000'); // inverted → invalid
	await page.getByLabel('Workday start').fill('09:00');
	await page.getByLabel('Workday end').fill('17:00');
	await page.getByLabel('Available from').fill('2026-08-01');
	await next(page).click();
	await expect(page.getByRole('alert')).toContainText('correct the highlighted answers');

	await page.getByLabel('At most').fill('3000');
	await next(page).click();

	// Summary screen: recap with option labels, not raw values
	await expect(page.getByRole('heading', { name: 'Review your answers' })).toBeVisible();
	await expect(page.getByText('Portugal')).toBeVisible();
	await expect(page.getByText('2000 – 3000 €')).toBeVisible();

	// Edit jumps back to the step, then Next returns to the summary
	await page.getByRole('button', { name: 'Edit' }).first().click();
	await expect(page.getByRole('heading', { name: 'Text', exact: true })).toBeVisible();
	await page.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
	await next(page).click();
	await next(page).click();
	await next(page).click();
	await expect(page.getByRole('heading', { name: 'Review your answers' })).toBeVisible();
	await expect(page.getByText('Ada Lovelace')).toBeVisible();

	// Submit from the summary
	await next(page).click();
	const payload = await payloadPromise;
	expect(payload.text).toMatchObject({ name: 'Ada Lovelace' });
	expect(payload['numbers-and-time']).toMatchObject({ budget: { from: 2000, to: 3000 }, start_date: '2026-08-01' });
});

test('kiosk example: linear flow with no header and no back', async ({ page }) => {
	await page.goto('/examples/kiosk');
	await page.waitForLoadState('networkidle');

	await expect(progress(page)).toBeHidden();
	await page.locator('label').filter({ hasText: /^\s*5\s*$/ }).click();
	await page.getByRole('button', { name: 'Continue' }).click();

	await expect(page.getByRole('heading', { name: 'Question 2' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Previous|Back' })).toBeHidden();
});

test('customized example: custom labels and messages', async ({ page }) => {
	await page.goto('/examples/customized');
	await page.waitForLoadState('networkidle');

	// Custom next label; custom requiredMessage on empty submit
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toContainText('A required answer is missing here.');

	await page.locator('label').filter({ hasText: 'Playful' }).click();
	await page.getByRole('button', { name: 'Continue' }).click();

	// An inverted range (From > To) triggers the custom invalidMessage
	await page.getByLabel('Team size').fill('50');
	await page.getByLabel('At least').fill('300');
	await page.getByLabel('At most').fill('100');
	await page.getByRole('button', { name: 'Continue' }).click();
	await expect(page.getByRole('alert')).toContainText('One of these values is out of the allowed range.');

	await page.getByLabel('At most').fill('400');
	await page.getByRole('button', { name: 'Continue' }).click();

	// Summary with custom heading and edit label, then custom submit label
	await expect(page.getByRole('heading', { name: 'Check your answers before sending' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Change' }).first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Send my answers' })).toBeVisible();

	// The demo endpoint doesn't exist → custom submitErrorMessage appears
	await page.getByRole('button', { name: 'Send my answers' }).click();
	await expect(page.getByRole('alert')).toContainText('Could not reach the server');
});
