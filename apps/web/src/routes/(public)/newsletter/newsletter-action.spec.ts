import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../../lib/db/client.ts';
import { subscribers } from '../../../lib/modules/crm/schema.ts';
import { emailLog } from '../../../lib/modules/email/schema.ts';

// Route-level integration (audit 2026-09-03 P1 "Email, CRM & nurture"): the
// REAL newsletter action must answer identically for a new address and for
// one that is already confirmed — the old "already subscribed" branch was a
// confirmed-status oracle — and must record the consent evidence (ip, user
// agent, the consent copy version the visitor saw).
const appDbHolder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/db/index.ts')>();
	const { createDb: create } = await import('../../../lib/db/client.ts');
	return {
		...actual,
		getDb: () => {
			appDbHolder.db ??= create(process.env.TEST_DATABASE_URL!);
			return appDbHolder.db;
		}
	};
});

let db: Db;
type Page = typeof import('./+page.server.ts');
let action: Page['actions']['default'];

function event(email: string, ip = '203.0.113.9') {
	const body = new FormData();
	body.set('email', email);
	body.set('newsletter_consent', 'yes');
	body.set('source', 'footer');
	return {
		request: new Request('http://localhost/newsletter', {
			method: 'POST',
			body,
			headers: { 'user-agent': 'Mozilla/5.0 (newsletter-spec)' }
		}),
		getClientAddress: () => ip
	} as unknown as Parameters<Page['actions']['default']>[0];
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
	action = (await import('./+page.server.ts')).actions.default;
});

afterAll(async () => {
	await db?.$client.end();
});

describe('POST /newsletter', () => {
	it('answers "check your inbox" for a new AND for an already-confirmed address (oracle before the fix)', async () => {
		const fresh = await action(event('new@example.ro'));
		expect(fresh).toEqual({ status: 'sent' });

		await db.insert(subscribers).values({
			id: 'nl-confirmed',
			email: 'confirmed@example.ro',
			consents: { newsletter: { granted: true, at: '2026-01-01T00:00:00Z', source: 'footer' } },
			confirmedAt: new Date('2026-01-02T00:00:00Z'),
			unsubscribeToken: 'nl-confirmed-unsub'
		});
		const existing = await action(event('confirmed@example.ro'));
		expect(existing).toEqual(fresh);
		// …and still no second confirm email for the confirmed address.
		expect(
			await db.select().from(emailLog).where(eq(emailLog.toEmail, 'confirmed@example.ro'))
		).toEqual([]);
	});

	it('records ip, user agent and the consent copy version on the granted consent', async () => {
		await action(event('proof@example.ro', '198.51.100.23'));
		const [row] = await db.select().from(subscribers).where(eq(subscribers.email, 'proof@example.ro'));
		expect(row.consents.newsletter).toMatchObject({
			granted: true,
			source: 'footer',
			ip: '198.51.100.23',
			userAgent: 'Mozilla/5.0 (newsletter-spec)',
			consentTextVersion: 'newsletter_consent_label@1'
		});
	});
});
