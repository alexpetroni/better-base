import { expect, test, type Page } from '@playwright/test';

// The chat runs on the MOCK provider (playwright.config forces CHAT_PROVIDER=mock
// and an empty ANTHROPIC_API_KEY into the preview servers) — replies below are
// the deterministic canned answers from modules/chat/mock-provider.ts.

const SLEEP_QUESTION = 'Cum pot dormi mai bine?';
const SLEEP_REPLY_SNIPPET = 'Pentru un somn mai bun';

async function chatCookie(page: Page) {
	return (await page.context().cookies()).find((c) => c.name === 'chat_session')?.value;
}

function messages(page: Page, role: 'user' | 'assistant') {
	return page.locator(`[data-testid="chat-message"][data-role="${role}"]`);
}

async function send(page: Page, text: string) {
	await page.locator('input[name="chat-message"]').fill(text);
	await page.locator('form button[type="submit"]', { hasText: 'Trimite' }).click();
}

test('widget: streamed mock reply, disclaimer, reset starts a new session', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');

	await page.getByTestId('chat-toggle').click();
	await expect(page.getByTestId('chat-panel')).toBeVisible();
	await expect(page.getByTestId('chat-disclaimer')).toContainText('nu oferă sfaturi medicale');

	await send(page, SLEEP_QUESTION);
	await expect(messages(page, 'user')).toHaveText([SLEEP_QUESTION]);
	await expect(messages(page, 'assistant').last()).toContainText(SLEEP_REPLY_SNIPPET);

	// The signed session cookie was set by the streamed response.
	const firstSession = await chatCookie(page);
	expect(firstSession).toBeTruthy();

	// Reset: conversation clears, cookie is dropped, a fresh session works.
	await page.getByTestId('chat-reset').click();
	await expect(page.getByTestId('chat-message')).toHaveCount(0);
	await expect.poll(() => chatCookie(page)).toBeUndefined();

	await send(page, 'Salut!');
	await expect(messages(page, 'assistant').last()).toContainText('Salut');
	const secondSession = await chatCookie(page);
	expect(secondSession).toBeTruthy();
	expect(secondSession).not.toBe(firstSession);
});

test('full page /asistent chats too', async ({ page }) => {
	await page.goto('/asistent');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
	await expect(page.getByTestId('chat-disclaimer')).toBeVisible();

	await send(page, 'Vreau un test');
	await expect(messages(page, 'assistant').last()).toContainText('chestionar');
});

test('widget a11y: focus lands in a labelled input, replies live in an aria-live log, Escape closes', async ({
	page
}) => {
	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');

	await page.getByTestId('chat-toggle').click();
	await expect(page.getByTestId('chat-panel')).toBeVisible();

	// Opening moves focus into the (sr-only labelled) message input.
	const input = page.getByLabel('Mesajul tău');
	await expect(input).toBeFocused();

	// Streamed replies must be announced: role=log + polite live region.
	const log = page.getByTestId('chat-messages');
	await expect(log).toHaveAttribute('role', 'log');
	await expect(log).toHaveAttribute('aria-live', 'polite');
	await expect(log).toHaveAttribute('aria-atomic', 'false');

	// Escape closes the widget and hands focus back to the toggle.
	await page.keyboard.press('Escape');
	await expect(page.getByTestId('chat-panel')).toHaveCount(0);
	await expect(page.getByTestId('chat-toggle')).toBeFocused();
});

test('a mid-stream error marks the partial reply failed and retry re-asks it', async ({ page }) => {
	await page.goto('/asistent');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');

	// First delivery: an SSE stream that dies after a partial delta.
	await page.route('**/api/chat', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'text/event-stream',
			body: 'data: {"delta":"Un început de răspuns"}\n\ndata: {"error":"Conexiunea a fost întreruptă."}\n\n'
		})
	);
	await send(page, SLEEP_QUESTION);

	const failed = page.locator('[data-testid="chat-message"][data-failed="true"]');
	await expect(failed).toContainText('Un început de răspuns');
	await expect(page.getByTestId('chat-error')).toBeVisible();

	// Retry (now against the real mock provider) replaces the broken reply.
	await page.unroute('**/api/chat');
	await page.getByTestId('chat-retry').click();
	await expect(messages(page, 'assistant').last()).toContainText(SLEEP_REPLY_SNIPPET);
	await expect(failed).toHaveCount(0);
	await expect(messages(page, 'user')).toHaveCount(1);
});

test('rate limit surfaces as a friendly ro message in the widget', async ({ page }) => {
	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');

	// Exhaust the hourly IP budget via the API (shares the page's cookie jar).
	let limited = false;
	for (let i = 0; i < 25 && !limited; i++) {
		const res = await page.request.post('/api/chat', { data: { message: `mesaj ${i}` } });
		limited = res.status() === 429;
	}
	expect(limited).toBe(true);

	await page.getByTestId('chat-toggle').click();
	await send(page, 'încă unul');
	await expect(page.getByTestId('chat-error')).toContainText('prea multe mesaje');
});
