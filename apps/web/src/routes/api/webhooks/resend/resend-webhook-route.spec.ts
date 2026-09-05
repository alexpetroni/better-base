import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, type Db } from '../../../../lib/db/client.ts';
import { subscribers } from '../../../../lib/modules/crm/schema.ts';
import {
	nurtureEnrollments,
	nurtureSends,
	nurtureSequences
} from '../../../../lib/modules/nurture/schema.ts';

// Audit 2026-09-03 P1: bounces and complaints were never fed back. The REAL
// route, driven with Svix-signed payloads (the way Resend signs them), must
// withdraw the address and cancel its nurture; anything unsigned is refused.
const envHolder = vi.hoisted(() => ({
	env: { SITE_ID: 'sleep' } as Record<string, string | undefined>
}));
vi.mock('$env/dynamic/private', () => ({ env: envHolder.env }));

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

const SECRET = 'whsec_' + Buffer.from('route-spec-key-0123456789abcdef!').toString('base64');
let db: Db;
type Route = typeof import('./+server.ts');
let post: Route['POST'];
let seq = 0;

function signed(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
	const id = `msg_${seq}`;
	const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
	const sig = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
	return {
		request: new Request('http://localhost/api/webhooks/resend', {
			method: 'POST',
			body,
			headers: {
				'content-type': 'application/json',
				'svix-id': id,
				'svix-timestamp': String(timestamp),
				'svix-signature': `v1,${sig}`
			}
		})
	} as unknown as Parameters<Route['POST']>[0];
}

async function makeSubscriber() {
	seq += 1;
	const [row] = await db
		.insert(subscribers)
		.values({
			id: `rw-sub-${seq}`,
			email: `rw-${seq}@example.ro`,
			consents: { newsletter: { granted: true, at: '2026-01-01T00:00:00Z', source: 'footer' } },
			confirmedAt: new Date('2026-01-02T00:00:00Z'),
			unsubscribeToken: `rw-unsub-${seq}`
		})
		.returning();
	await db.insert(nurtureEnrollments).values({
		id: `rw-enr-${seq}`,
		sequenceId: 'rw-seq',
		subscriberId: row.id
	});
	await db.insert(nurtureSends).values({
		id: `rw-send-${seq}`,
		enrollmentId: `rw-enr-${seq}`,
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
	return { row, enrollment };
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
		id: 'rw-seq',
		key: 'rw-seq',
		name: 'S',
		trigger: { kind: 'consent-confirmed' },
		steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'S', paragraphs: ['P'] }]
	});
	post = (await import('./+server.ts')).POST;
});

afterAll(async () => {
	await db?.$client.end();
});

describe('POST /api/webhooks/resend', () => {
	it('answers 503 while RESEND_WEBHOOK_SECRET is unset (never falls open)', async () => {
		delete envHolder.env.RESEND_WEBHOOK_SECRET;
		const response = await post(signed('{}'));
		expect(response.status).toBe(503);
	});

	it('refuses a bad signature and a stale timestamp with 400, touching nothing', async () => {
		envHolder.env.RESEND_WEBHOOK_SECRET = SECRET;
		const subscriber = await makeSubscriber();
		const body = JSON.stringify({ type: 'email.bounced', data: { to: [subscriber.email] } });
		const other = 'whsec_' + Buffer.from('some-other-key-some-other-key-00').toString('base64');
		expect((await post(signed(body, other))).status).toBe(400);
		expect((await post(signed(body, SECRET, Math.floor(Date.now() / 1000) - 600))).status).toBe(
			400
		);
		expect((await state(subscriber.id)).row.consents.newsletter?.granted).toBe(true);
	});

	it('email.bounced withdraws the address (source bounce) and cancels its nurture', async () => {
		envHolder.env.RESEND_WEBHOOK_SECRET = SECRET;
		const subscriber = await makeSubscriber();
		const body = JSON.stringify({
			type: 'email.bounced',
			created_at: '2026-09-05T10:00:00.000Z',
			data: { email_id: 'e_1', to: [subscriber.email.toUpperCase()], bounce: { type: 'Permanent' } }
		});
		const response = await post(signed(body));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ received: true, kind: 'bounce', revoked: 1 });
		const { row, enrollment } = await state(subscriber.id);
		expect(row.consents.newsletter).toMatchObject({ granted: false, source: 'bounce' });
		expect(row.confirmedAt).toBeNull();
		expect(enrollment.status).toBe('cancelled');
	});

	it('email.complained withdraws with source complaint; other events are acknowledged and ignored', async () => {
		envHolder.env.RESEND_WEBHOOK_SECRET = SECRET;
		const subscriber = await makeSubscriber();
		const complaint = JSON.stringify({
			type: 'email.complained',
			data: { to: [subscriber.email] }
		});
		expect(await (await post(signed(complaint))).json()).toEqual({
			received: true,
			kind: 'complaint',
			revoked: 1
		});
		expect((await state(subscriber.id)).row.consents.newsletter?.source).toBe('complaint');

		const bystander = await makeSubscriber();
		const delivered = JSON.stringify({ type: 'email.delivered', data: { to: [bystander.email] } });
		expect(await (await post(signed(delivered))).json()).toEqual({ received: true, ignored: true });
		expect((await state(bystander.id)).row.consents.newsletter?.granted).toBe(true);
	});
});
