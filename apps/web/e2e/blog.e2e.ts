import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { E2E_EDITOR } from './env.ts';

// Full blog flow, on BOTH sites: an editor uploads a cover to the media
// library, writes + publishes an article tagged `somn`, and the public site
// shows it with imgproxy-served images, correct SEO tags and a sitemap entry.
// (`somn` is active on sleep AND life, so publishing on the life site also
// proves the DoD case "an article tagged only sleep appears on life".)

// Own fixture file: media.e2e.ts runs in parallel against the same library,
// so filename-based filters must not collide across suites.
const FIXTURE = path.resolve(import.meta.dirname, '../tests/fixtures/blog-cover.png');
const FIXTURE_NAME = 'blog-cover.png';

const TITLE = 'Articol de test E2E';
const SLUG = 'articol-de-test-e2e';
const SEO_TITLE = 'Titlu SEO E2E';
const SEO_DESCRIPTION = 'Descriere SEO pentru articolul de test.';

async function login(page: Page, credentials: { email: string; password: string }) {
	await page.goto('/admin/login');
	await page.locator('input[name="email"]').fill(credentials.email);
	await page.locator('input[name="password"]').fill(credentials.password);
	await page.locator('button[type="submit"]').click();
	await expect(page).toHaveURL(/\/admin$/);
}

async function expectRenderedImage(page: Page, scope: ReturnType<Page['locator']>) {
	const img = scope.locator('img').first();
	await expect(img).toBeVisible();
	await expect
		.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
		.toBeGreaterThan(0);
}

test('editor writes and publishes an article; the public site serves it with SEO and sitemap', async ({
	page,
	baseURL
}) => {
	await login(page, E2E_EDITOR);

	// A cover image must exist in the media library first.
	await page.goto('/admin/media');
	await page.getByTestId('media-file-input').setInputFiles(FIXTURE);
	await expect(page.getByTestId('media-item').filter({ hasText: FIXTURE_NAME })).toBeVisible();

	// Create the article from the admin list.
	await page.goto('/admin/articles');
	await page.getByTestId('article-new-title').fill(TITLE);
	await page.getByTestId('article-create').click();
	await expect(page).toHaveURL(/\/admin\/articles\/[a-z0-9-]+$/);
	await expect(page.getByTestId('editor-slug')).toHaveValue(SLUG);
	await expect(page.getByTestId('editor-status')).toHaveText('ciornă');

	// Fill the body + SEO fields, tag the somn pillar.
	await page.getByTestId('editor-excerpt').fill('Un rezumat scurt pentru cardul de pe blog.');
	await page
		.getByTestId('editor-body')
		.fill('## Subtitlu de test\n\nParagraf **important** despre somn.\n\n');
	await page.getByTestId('editor-seo-title').fill(SEO_TITLE);
	await page.getByTestId('editor-seo-description').fill(SEO_DESCRIPTION);
	await page.getByTestId('editor-pillar-somn').check();

	// Pick the cover from the media library.
	await page.getByTestId('editor-cover-pick').click();
	await page.getByTestId('media-picker-item').filter({ hasText: FIXTURE_NAME }).first().click();
	await expect(page.getByTestId('media-picker')).toHaveCount(0);

	// Insert the same library image inline into the markdown body.
	await page.getByTestId('editor-insert-image').click();
	await page.getByTestId('media-picker-item').filter({ hasText: FIXTURE_NAME }).first().click();
	await expect(page.getByTestId('editor-body')).toHaveValue(/!\[[^\]]*\]\(media:[^)]+\)/);

	// The preview renders the markdown server-side (sanitized pipeline).
	await page.getByTestId('editor-show-preview').click();
	await expect(page.getByTestId('editor-preview').locator('h2')).toHaveText('Subtitlu de test');
	await page.getByTestId('editor-show-editor').click();

	await page.getByTestId('editor-save').click();
	await expect(page.getByTestId('editor-saved')).toBeVisible();

	// Still a draft: publicly invisible, list and detail both.
	const draftResponse = await page.request.get(`/blog/${SLUG}`);
	expect(draftResponse.status()).toBe(404);
	expect(await page.request.get('/sitemap.xml').then((r) => r.text())).not.toContain(
		`/blog/${SLUG}`
	);

	// Publish.
	await page.getByTestId('editor-publish').click();
	await expect(page.getByTestId('editor-status')).toHaveText('publicat');
	await expect(page.getByTestId('editor-view-public')).toBeVisible();

	// Public list: the card is there and its cover really renders via imgproxy.
	await page.goto('/blog');
	const card = page.locator(`[data-testid="blog-card"][data-slug="${SLUG}"]`);
	await expect(card).toBeVisible();
	await expectRenderedImage(page, card);

	// List page SEO basics.
	await expect(page).toHaveTitle(/Blog · /);
	await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.+/);
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/blog$/);
	await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Blog/);

	// Article page: content + cover + inline image render.
	await card.locator('a').first().click();
	await expect(page).toHaveURL(new RegExp(`/blog/${SLUG}$`));
	await expect(page.getByTestId('article-title')).toHaveText(TITLE);
	await expect(page.getByTestId('article-body').locator('h2')).toHaveText('Subtitlu de test');
	await expectRenderedImage(page, page.getByTestId('article-page'));
	await expectRenderedImage(page, page.getByTestId('article-body'));

	// Article page SEO: title/description from the SEO fields, canonical,
	// OG + twitter card with the imgproxy cover, JSON-LD Article.
	await expect(page).toHaveTitle(SEO_TITLE);
	await expect(page.locator('meta[name="description"]')).toHaveAttribute(
		'content',
		SEO_DESCRIPTION
	);
	await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
		'href',
		new RegExp(`/blog/${SLUG}$`)
	);
	await expect(page.locator('meta[property="og:type"]')).toHaveAttribute('content', 'article');
	await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /https?:/);
	await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
		'content',
		'summary_large_image'
	);
	const jsonLd = await page.locator('script[type="application/ld+json"]').textContent();
	expect(JSON.parse(jsonLd ?? '{}')).toMatchObject({ '@type': 'Article', headline: TITLE });

	// Sitemap now lists the article.
	const sitemap = await page.request.get('/sitemap.xml').then((r) => r.text());
	expect(sitemap).toContain(`/blog/${SLUG}`);

	// The pillar landing page lists it too.
	await page.goto('/sanatate/somn');
	await expect(
		page.locator(`[data-testid="pillar-article-card"][data-slug="${SLUG}"]`)
	).toBeVisible();

	// Unpublish → gone from the public site again.
	await page.goto(`${baseURL}/admin/articles`);
	await page.locator(`[data-testid="article-row"][data-slug="${SLUG}"]`).click();
	await page.getByTestId('editor-unpublish').click();
	await expect(page.getByTestId('editor-status')).toHaveText('ciornă');
	expect((await page.request.get(`/blog/${SLUG}`)).status()).toBe(404);
});
