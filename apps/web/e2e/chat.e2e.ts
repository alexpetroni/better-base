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
