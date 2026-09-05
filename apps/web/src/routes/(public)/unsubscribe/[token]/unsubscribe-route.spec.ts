import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isActionFailure } from '@sveltejs/kit';
import { createDb, type Db } from '../../../../lib/db/client.ts';
import { subscribers } from '../../../../lib/modules/crm/schema.ts';
import {
	nurtureEnrollments,
	nurtureSends,
	nurtureSequences
} from '../../../../lib/modules/nurture/schema.ts';

// Audit 2026-09-03 P1: unsubscribe was a GET side effect — mail scanners
// (Safe Links, Gmail, Apple MPP) fetch every link, so the first nurture email
// unsubscribed such mailboxes. GET must now only render the confirmation;
// revocation happens on the form POST, or on the RFC 8058 one-click POST
// mail clients send to the same URL.
const appDbHolder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('$lib/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../../lib/db/index.ts')>();
	const { createDb: create } = await import('../../../../lib/db/client.ts');
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

async function makeSubscriber() {
	seq += 1;
	const [row] = await db
		.insert(subscribers)
		.values({
			id: `unsub-sub-${seq}`,
			email: `unsub-${seq}@example.ro`,
			consents: {
				newsletter: { granted: true, at: '2026-01-01T00:00:00Z', source: 'footer' },
				profile_emails: { granted: true, at: '2026-01-01T00:00:00Z', source: 'quiz:x' }
			},
			confirmedAt: new Date('2026-01-02T00:00:00Z'),
			unsubscribeToken: `unsub-token-${seq}`
		})
		.returning();
	await db.insert(nurtureEnrollments).values({
		id: `unsub-enr-${seq}`,
		sequenceId: 'unsub-seq',
		subscriberId: row.id
	});
	await db.insert(nurtureSends).values({
		id: `unsub-send-${seq}`,
		enrollmentId: `unsub-enr-${seq}`,
		stepIndex: 0,
		scheduledAt: new Date('2026-01-03T00:00:00Z')
	});
	return row;
}

async function state(id: string) {
	const [row] = await db.select().from(subscribers).where(eq(subscribers.id, id));
	const [enrollment] = await db
		.select()
		.from(nurtureEnrollments)
		.where(eq(nurtureEnrollments.subscriberId, id));
	const [send] = await db
		.select()
		.from(nurtureSends)
		.where(eq(nurtureSends.enrollmentId, enrollment.id));
	return { row, enrollment, send };
}

const loadEvent = (token: string) => ({ params: { token } }) as Parameters<Page['load']>[0];

function postEvent(token: string, body: BodyInit, contentType?: string) {
	return {
		params: { token },
		request: new Request(`http://localhost/unsubscribe/${token}`, {
			method: 'POST',
			body,
			headers: contentType ? { 'content-type': contentType } : {}
		})
	} as unknown as Parameters<Page['actions']['default']>[0];
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../../../drizzle')
	});
	await db.insert(nurtureSequences).values({
		id: 'unsub-seq',
		key: 'unsub-seq',
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

describe('GET /unsubscribe/[token]', () => {
	it('renders the confirmation and changes NOTHING (revoked on GET before the fix)', async () => {
		const subscriber = await makeSubscriber();
		expect(await load(loadEvent(subscriber.unsubscribeToken))).toEqual({ valid: true });
		const { row, enrollment, send } = await state(subscriber.id);
		expect(row.consents.newsletter?.granted).toBe(true);
		expect(row.confirmedAt).not.toBeNull();
		expect(enrollment.status).toBe('active');
		expect(send.status).toBe('pending');
	});

	it('reports an unknown token as invalid', async () => {
		expect(await load(loadEvent('no-such-token'))).toEqual({ valid: false });
	});
});

describe('POST /unsubscribe/[token]', () => {
	it('the confirmation form revokes every consent, clears confirmed_at and cancels nurture', async () => {
		const subscriber = await makeSubscriber();
		const body = new FormData();
		body.set('intent', 'unsubscribe');
		expect(await action(postEvent(subscriber.unsubscribeToken, body))).toEqual({ done: true });
		const { row, enrollment, send } = await state(subscriber.id);
		expect(row.consents.newsletter).toMatchObject({ granted: false, source: 'unsubscribe' });
		expect(row.consents.profile_emails).toMatchObject({ granted: false, source: 'unsubscribe' });
		expect(row.confirmedAt).toBeNull();
		expect(enrollment.status).toBe('cancelled');
		expect(send.status).toBe('cancelled');
	});

	it('the RFC 8058 one-click POST (List-Unsubscribe=One-Click, urlencoded, no origin) revokes too', async () => {
		const subscriber = await makeSubscriber();
		const outcome = await action(
			postEvent(
				subscriber.unsubscribeToken,
				'List-Unsubscribe=One-Click',
				'application/x-www-form-urlencoded'
			)
		);
		expect(outcome).toEqual({ done: true });
		const { row, send } = await state(subscriber.id);
		expect(row.consents.newsletter?.granted).toBe(false);
		expect(row.confirmedAt).toBeNull();
		expect(send.status).toBe('cancelled');
	});

	it('an unknown token or an unrelated body revokes nobody', async () => {
		const subscriber = await makeSubscriber();
		const unknown = await action(
			postEvent('no-such-token', 'List-Unsubscribe=One-Click', 'application/x-www-form-urlencoded')
		);
		expect(isActionFailure(unknown) && unknown.status).toBe(404);
		const body = new FormData();
		body.set('intent', 'something-else');
		const unrelated = await action(postEvent(subscriber.unsubscribeToken, body));
		expect(isActionFailure(unrelated) && unrelated.status).toBe(400);
		expect((await state(subscriber.id)).row.consents.newsletter?.granted).toBe(true);
	});
});
