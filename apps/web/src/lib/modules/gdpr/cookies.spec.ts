import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { selectAnalyticsProvider } from '$lib/modules/analytics';
import { CHAT_SESSION_COOKIE } from '$lib/modules/chat/server';
import { CART_COOKIE } from '$lib/modules/shop';
import { cookieMaxAge, cookieName as paraglideCookieName } from '$lib/paraglide/runtime';
import { CONSENT_COOKIE, CONSENT_MAX_AGE_SECONDS } from './consent.ts';
import { COOKIE_INVENTORY, isInventoriedCookie } from './cookies.ts';
import CookieTable from './CookieTable.svelte';

const SRC_ROOT = path.resolve(import.meta.dirname, '../../..');
const SECONDS_PER_DAY = 24 * 3600;

function sourceFiles(): string[] {
	return readdirSync(SRC_ROOT, { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.join(entry.parentPath, entry.name))
		.filter(
			(file) =>
				(file.endsWith('.ts') || file.endsWith('.svelte')) &&
				!file.endsWith('.spec.ts') &&
				!file.includes(`${path.sep}paraglide${path.sep}`)
		);
}

describe('cookie inventory', () => {
	it('stays in sync with the authoritative cookie-name constants', () => {
		// The inventory duplicates server-only names as literals (it must stay
		// client-importable); these assertions pin them to the real constants.
		for (const name of [CART_COOKIE, CONSENT_COOKIE, CHAT_SESSION_COOKIE, paraglideCookieName]) {
			expect(isInventoriedCookie(name), `"${name}" missing from COOKIE_INVENTORY`).toBe(true);
		}
		expect(isInventoriedCookie('better-auth.session_token')).toBe(true);
	});

	it('documents the lifetimes the code actually sets', () => {
		const byName = new Map(COOKIE_INVENTORY.map((entry) => [entry.name, entry]));
		expect(byName.get(CONSENT_COOKIE)?.maxAgeDays).toBe(CONSENT_MAX_AGE_SECONDS / SECONDS_PER_DAY);
		expect(byName.get(paraglideCookieName)?.maxAgeDays).toBe(cookieMaxAge / SECONDS_PER_DAY);
	});

	it('covers every cookie write in the codebase (a new cookie must get a policy entry)', () => {
		// Every `cookies.set/delete(<name>, …)` in src must resolve — through a
		// literal or one of the known name constants — to an inventoried cookie.
		// An unknown identifier fails too: add it to KNOWN_NAME_CONSTANTS *and*
		// the inventory (which puts it on the public cookie policy).
		const KNOWN_NAME_CONSTANTS: Record<string, string> = {
			CART_COOKIE,
			CONSENT_COOKIE,
			CHAT_SESSION_COOKIE
		};
		const writes: Array<{ file: string; token: string }> = [];
		for (const file of sourceFiles()) {
			const content = readFileSync(file, 'utf8');
			for (const match of content.matchAll(
				/cookies\.(?:set|delete)\(\s*([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")/gu
			)) {
				writes.push({ file, token: match[1] });
			}
		}
		expect(writes.length).toBeGreaterThan(0);
		for (const { file, token } of writes) {
			const name =
				token.startsWith("'") || token.startsWith('"')
					? token.slice(1, -1)
					: KNOWN_NAME_CONSTANTS[token];
			expect(
				name,
				`${file}: cookies.set/delete(${token}) uses an identifier unknown to cookies.spec.ts`
			).toBeDefined();
			expect(
				isInventoriedCookie(name as string),
				`${file}: cookie "${name}" is set but missing from COOKIE_INVENTORY (and thus from the cookie policy)`
			).toBe(true);
		}
	});

	it('confines document.cookie writes to the gdpr and analytics modules', () => {
		for (const file of sourceFiles()) {
			if (!/document\.cookie\s*=/u.test(readFileSync(file, 'utf8'))) continue;
			expect(
				file.includes(path.join('modules', 'gdpr')) ||
					file.includes(path.join('modules', 'analytics')),
				`${file} writes document.cookie outside the gdpr/analytics modules — inventory it`
			).toBe(true);
		}
		expect.hasAssertions();
	});

	it('rejects analytics providers that set cookies missing from the inventory', () => {
		// Both supported providers run cookieless today; if one ever declares a
		// cookie, it must be inventoried (and thereby land on the policy page).
		for (const provider of ['plausible', 'umami']) {
			const config = selectAnalyticsProvider({
				PUBLIC_ANALYTICS_PROVIDER: provider,
				PUBLIC_ANALYTICS_HOST: 'https://stats.example.com',
				PUBLIC_ANALYTICS_SITE_ID: 'x'
			});
			for (const name of config?.cookieNames ?? []) {
				expect(isInventoriedCookie(name), `provider cookie "${name}" not inventoried`).toBe(true);
			}
			expect(config).not.toBeNull();
		}
	});
});

describe('CookieTable component (SSR)', () => {
	it('renders one row per inventoried cookie plus the cookieless-analytics note', () => {
		const { body } = render(CookieTable, { props: {} });
		for (const entry of COOKIE_INVENTORY) {
			expect(body).toContain(entry.name);
		}
		expect(body).toContain('data-testid="cookie-table"');
		expect(body).toContain('data-testid="cookie-analytics-note"');
	});
});
