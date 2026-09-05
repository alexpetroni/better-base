import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../../../../lib/db/client.ts';
import { subscribers } from '../../../../../lib/modules/crm/schema.ts';
import { signToken } from '../../../../../lib/modules/crm/token.ts';
import { NEWSLETTER_CONFIRM_PURPOSE } from '../../../../../lib/modules/crm/service.ts';
import { nurtureEnrollments, nurtureSequences } from '../../../../../lib/modules/nurture/schema.ts';

// The double-opt-in confirm link follows the unsubscribe pattern (audit
// 2026-09-03 P1): GET only verifies the token and shows a button; the POST
// confirms and enrolls. A link scanner's GET must not confirm a subscription.
const appDbHolder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../../../lib/db/index.ts')>();
	const { createDb: create } = await import('../../../../../lib/db/client.ts');
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
let load: Page['load'];
let action: Page['actions']['default'];
let seq = 0;

function token(sub: string, expSeconds = Math.floor(Date.now() / 1000) + 3600) {
	return signToken(process.env.TOKEN_SECRET!, {
		sub,
		purpose: NEWSLETTER_CONFIRM_PURPOSE,
		exp: expSeconds
	});
}

async function makeSubscriber() {
	seq += 1;
	const [row] = await db
		.insert(subscribers)
		.values({
			id: `confirm-sub-${seq}`,
			email: `confirm-${seq}@example.ro`,
			consents: { newsletter: { granted: true, at: '2026-01-01T00:00:00Z', source: 'footer' } },
			unsubscribeToken: `confirm-unsub-${seq}`
		})
		.returning();
	return row;
}

const loadEvent = (t: string) => ({ params: { token: t } }) as Parameters<Page['load']>[0];
const postEvent = (t: string) =>
	({
		params: { token: t },
		request: new Request(`http://localhost/newsletter/confirm/${t}`, { method: 'POST' })
	}) as unknown as Parameters<Page['actions']['default']>[0];

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	if (!process.env.TOKEN_SECRET) throw new Error('TOKEN_SECRET is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../../../../drizzle')
	});
	await db.insert(nurtureSequences).values({
		id: 'confirm-seq',
		key: 'confirm-seq',
		name: 'S',
		trigger: { kind: 'consent-confirmed' },
		steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'S', paragraphs: ['P'] }]
	});
	const page = await import('./+page.server.ts');
	load = page.load;
	action = page.actions.default;
});

afterAll(async () => {
	await db?.$client.end();
});

describe('/newsletter/confirm/[token]', () => {
	it('GET verifies the token and confirms NOTHING (confirmed on GET before the fix)', async () => {
		const subscriber = await makeSubscriber();
		expect(await load(loadEvent(token(subscriber.id)))).toEqual({ status: 'valid' });
		const [row] = await db.select().from(subscribers).where(eq(subscribers.id, subscriber.id));
		expect(row.confirmedAt).toBeNull();
		expect(
			await db.select().from(nurtureEnrollments).where(eq(nurtureEnrollments.subscriberId, row.id))
		).toEqual([]);
	});

	it('GET reports expired and tampered tokens without touching the row', async () => {
		const subscriber = await makeSubscriber();
		expect(await load(loadEvent(token(subscriber.id, 1)))).toEqual({ status: 'expired' });
		expect(await load(loadEvent('garbage.token'))).toEqual({ status: 'invalid' });
	});

	it('POST confirms once, enrolls into consent-confirmed sequences, and is idempotent', async () => {
		const subscriber = await makeSubscriber();
		const t = token(subscriber.id);
		expect(await action(postEvent(t))).toEqual({ status: 'confirmed' });
		const [row] = await db.select().from(subscribers).where(eq(subscribers.id, subscriber.id));
		expect(row.confirmedAt).not.toBeNull();
		const enrollments = await db
			.select()
			.from(nurtureEnrollments)
			.where(eq(nurtureEnrollments.subscriberId, row.id));
		expect(enrollments.map((e) => e.sequenceId)).toEqual(['confirm-seq']);

		expect(await action(postEvent(t))).toEqual({ status: 'already' });
		expect(await action(postEvent('garbage.token'))).toEqual({ status: 'invalid' });
	});
});
