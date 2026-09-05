import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isActionFailure, isHttpError } from '@sveltejs/kit';
import { createDb, type Db } from '../../../../lib/db/client.ts';
import { subscribers } from '../../../../lib/modules/crm/schema.ts';
import { createSettingsLoader } from '../../../../lib/modules/settings/service.ts';
import {
	nurtureEnrollments,
	nurtureSends,
	nurtureSequences
} from '../../../../lib/modules/nurture/schema.ts';

// Route-level integration: the REAL /admin/nurture load and toggle action —
// the operator must be able to see queue health and stop a bad sequence
// without a deploy, and an editor must not.
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

const ADMIN = {
	id: 'nurture-page-admin',
	email: 'nurture-admin@example.com',
	name: 'Nurture Admin',
	role: 'admin' as const
};
const EDITOR = {
	id: 'nurture-page-editor',
	email: 'nurture-editor@example.com',
	name: 'Nurture Editor',
	role: 'editor' as const
};

type Page = typeof import('./+page.server.ts');
let load: Page['load'];
let toggle: (event: { request: Request; locals: App.Locals }) => Promise<unknown>;
let retry: (event: { request: Request; locals: App.Locals }) => Promise<unknown>;

function locals(user: typeof ADMIN | typeof EDITOR | null): App.Locals {
	return { user, settings: createSettingsLoader(() => db) };
}

function toggleEvent(user: typeof ADMIN | typeof EDITOR | null, fields: Record<string, string>) {
	return actionEvent('toggle', user, fields);
}

function actionEvent(
	name: 'toggle' | 'retry',
	user: typeof ADMIN | typeof EDITOR | null,
	fields: Record<string, string>
) {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request(`http://localhost/admin/nurture?/${name}`, { method: 'POST', body }),
		locals: locals(user)
	};
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
	const page = await import('./+page.server.ts');
	load = page.load;
	toggle = page.actions.toggle as typeof toggle;
	retry = page.actions.retry as typeof retry;

	// One sequence with one enrollment: a sent step and a parked step.
	await db.insert(nurtureSequences).values({
		id: 'np-seq',
		key: 'np-seq',
		name: 'Bun venit',
		trigger: { kind: 'consent-confirmed' },
		steps: [
			{ offsetDays: 0, templateKey: 'nurture', subject: 'S1', paragraphs: ['P'] },
			{ offsetDays: 3, templateKey: 'nurture', subject: 'S2', paragraphs: ['P'] }
		]
	});
	await db.insert(subscribers).values({
		id: 'np-sub',
		email: 'np-sub@example.ro',
		consents: { newsletter: { granted: true, at: '2026-01-01T00:00:00Z', source: 'test' } },
		confirmedAt: new Date('2026-01-01T00:00:00Z'),
		unsubscribeToken: 'np-unsub'
	});
	await db.insert(nurtureEnrollments).values({
		id: 'np-enr',
		sequenceId: 'np-seq',
		subscriberId: 'np-sub'
	});
	await db.insert(nurtureSends).values([
		{
			id: 'np-send-0',
			enrollmentId: 'np-enr',
			stepIndex: 0,
			scheduledAt: new Date('2026-01-01T00:00:00Z'),
			status: 'sent',
			sentAt: new Date('2026-01-01T00:05:00Z')
		},
		{
			id: 'np-send-1',
			enrollmentId: 'np-enr',
			stepIndex: 1,
			scheduledAt: new Date('2026-01-04T00:00:00Z'),
			status: 'failed',
			attempts: 5,
			lastError: 'smtp down'
		}
	]);
});

afterAll(async () => {
	await db.$client.end();
});

describe('/admin/nurture', () => {
	it('lists sequences with enrollment/send stats and surfaces parked sends', async () => {
		const data = (await load({ locals: locals(ADMIN) } as Parameters<Page['load']>[0])) as {
			sequences: import('../../../../lib/modules/nurture/service.ts').SequenceStats[];
			parked: import('../../../../lib/modules/nurture/service.ts').ParkedSend[];
		};
		const row = data.sequences.find((s) => s.sequence.key === 'np-seq');
		expect(row).toMatchObject({
			enrolled: 1,
			activeEnrollments: 1,
			pendingSends: 0,
			sentSends: 1,
			failedSends: 1
		});
		expect(data.parked).toHaveLength(1);
		expect(data.parked[0]).toMatchObject({
			sendId: 'np-send-1',
			email: 'np-sub@example.ro',
			stepIndex: 1,
			attempts: 5,
			lastError: 'smtp down'
		});
	});

	it('editor gets 403 from the toggle action and nothing is written', async () => {
		let threw = false;
		try {
			await toggle(toggleEvent(EDITOR, { id: 'np-seq', active: 'false' }));
		} catch (err) {
			threw = true;
			if (!isHttpError(err)) throw err;
			expect(err.status).toBe(403);
		}
		expect(threw).toBe(true);
		const [row] = await db.select().from(nurtureSequences).where(eq(nurtureSequences.id, 'np-seq'));
		expect(row.active).toBe(true);
	});

	it('admin deactivates and reactivates a sequence (the no-deploy kill switch)', async () => {
		expect(await toggle(toggleEvent(ADMIN, { id: 'np-seq', active: 'false' }))).toEqual({
			toggled: true
		});
		let [row] = await db.select().from(nurtureSequences).where(eq(nurtureSequences.id, 'np-seq'));
		expect(row.active).toBe(false);

		expect(await toggle(toggleEvent(ADMIN, { id: 'np-seq', active: 'true' }))).toEqual({
			toggled: true
		});
		[row] = await db.select().from(nurtureSequences).where(eq(nurtureSequences.id, 'np-seq'));
		expect(row.active).toBe(true);
	});

	it('rejects an unknown id or malformed payload without writing', async () => {
		const missing = await toggle(toggleEvent(ADMIN, { id: 'nope', active: 'false' }));
		expect(isActionFailure(missing) && missing.status === 400).toBe(true);
		const malformed = await toggle(toggleEvent(ADMIN, { id: 'np-seq', active: 'maybe' }));
		expect(isActionFailure(malformed) && malformed.status === 400).toBe(true);
	});

	// Audit 2026-09-03 P2: parked sends had no way back into the queue.
	it('editor gets 403 from the retry action; admin re-queues the parked send', async () => {
		await expect(retry(actionEvent('retry', EDITOR, { id: 'np-send-1' }))).rejects.toSatisfy(
			(e) => isHttpError(e) && e.status === 403
		);
		let [send] = await db.select().from(nurtureSends).where(eq(nurtureSends.id, 'np-send-1'));
		expect(send.status).toBe('failed');

		expect(await retry(actionEvent('retry', ADMIN, { id: 'np-send-1' }))).toEqual({
			retried: true
		});
		[send] = await db.select().from(nurtureSends).where(eq(nurtureSends.id, 'np-send-1'));
		expect(send).toMatchObject({ status: 'pending', attempts: 0, lastError: null });
		// The parked list is empty now; a second retry of a pending row is refused.
		const after = (await load({ locals: locals(ADMIN) } as Parameters<Page['load']>[0])) as {
			parked: unknown[];
		};
		expect(after.parked).toEqual([]);
		const again = await retry(actionEvent('retry', ADMIN, { id: 'np-send-1' }));
		expect(isActionFailure(again) && again.status).toBe(400);
	});
});
