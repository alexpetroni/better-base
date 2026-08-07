import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isActionFailure, isHttpError } from '@sveltejs/kit';
import { createDb, type Db } from '../../../../lib/db/client.ts';
import { users } from '../../../../lib/modules/auth/schema.ts';
import { createSettingsLoader } from '../../../../lib/modules/settings/service.ts';
import {
	listOrderEvents,
	transitionFulfillment
} from '../../../../lib/modules/shop/fulfillment-service.ts';
import type { FulfillmentStatus } from '../../../../lib/modules/shop/fulfillment.ts';
import { invoices } from '../../../../lib/modules/invoice/schema.ts';
import { siteSettings } from '../../../../lib/modules/settings/schema.ts';
import { orderEvents, orders, type OrderRow } from '../../../../lib/modules/shop/schema.ts';
import { listOrders } from '../../../../lib/modules/shop/webhook.ts';

// Route-level integration: the REAL /admin/orders work queue and the REAL
// /admin/orders/[id] transition action, invoked the way SvelteKit invokes
// them. `$env` values are a build-time snapshot under vitest, so the app db
// is redirected to TEST_DATABASE_URL by mocking `$lib/db`.
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
	id: 'orders-page-admin',
	email: 'orders-admin@example.com',
	name: 'Orders Admin',
	role: 'admin' as const
};
const EDITOR = {
	id: 'orders-page-editor',
	email: 'orders-editor@example.com',
	name: 'Orders Editor',
	role: 'editor' as const
};

type ListPage = typeof import('./+page.server.ts');
type DetailPage = typeof import('./[id]/+page.server.ts');
let listLoad: ListPage['load'];
let detailLoad: DetailPage['load'];
let transitionAction: (event: {
	request: Request;
	params: { id: string };
	locals: App.Locals;
}) => Promise<unknown>;
let issueInvoiceAction: (event: { params: { id: string }; locals: App.Locals }) => Promise<unknown>;

function locals(user: typeof ADMIN | typeof EDITOR | null): App.Locals {
	return { user, settings: createSettingsLoader(() => db) };
}

function transitionEvent(
	orderId: string,
	user: typeof ADMIN | typeof EDITOR | null,
	fields: Record<string, string>
): { request: Request; params: { id: string }; locals: App.Locals } {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request(`http://localhost/admin/orders/${orderId}?/transition`, {
			method: 'POST',
			body
		}),
		params: { id: orderId },
		locals: locals(user)
	};
}

let orderSeq = 0;
async function insertOrder(input: {
	status?: OrderRow['status'];
	fulfillment?: FulfillmentStatus;
	oversold?: boolean;
}): Promise<OrderRow> {
	orderSeq += 1;
	const [row] = await db
		.insert(orders)
		.values({
			id: `order-q-${orderSeq}`,
			email: `client${orderSeq}@example.ro`,
			stripeSessionId: `cs_queue_${orderSeq}`,
			amountTotalCents: 4990,
			currency: 'ron',
			status: input.status ?? 'paid',
			fulfillmentStatus: input.fulfillment ?? 'unfulfilled',
			oversold: input.oversold ?? false
		})
		.returning();
	return row;
}

async function loadIds(url: string): Promise<{ filter: string; ids: string[] }> {
	const data = (await listLoad({ url: new URL(url) } as Parameters<ListPage['load']>[0])) as {
		filter: string;
		orders: OrderRow[];
	};
	return { filter: data.filter, ids: data.orders.map((o) => o.id).sort() };
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) {
		throw new Error(
			'TEST_DATABASE_URL is not set — start the database with `docker compose up -d db` and configure .env'
		);
	}
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../../../drizzle')
	});
	await db.insert(users).values([
		{ id: ADMIN.id, name: ADMIN.name, email: ADMIN.email },
		{ id: EDITOR.id, name: EDITOR.name, email: EDITOR.email }
	]);

	const listPage = await import('./+page.server.ts');
	listLoad = listPage.load;
	const detailPage = await import('./[id]/+page.server.ts');
	detailLoad = detailPage.load;
	transitionAction = detailPage.actions.transition as unknown as typeof transitionAction;
	issueInvoiceAction = detailPage.actions.issueInvoice as unknown as typeof issueInvoiceAction;
});

afterAll(async () => {
	await (appDbHolder.db as Db | undefined)?.$client.end();
	await db?.$client.end();
});

describe('fulfillment service (the single writer)', () => {
	it('applies a legal transition and appends the matching order event atomically', async () => {
		const order = await insertOrder({});
		const result = await transitionFulfillment({ db }, order.id, 'packed', {
			actor: ADMIN.email,
			note: 'raft 3'
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.order.fulfillmentStatus).toBe('packed');

		const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(row.fulfillmentStatus).toBe('packed');
		const events = await listOrderEvents({ db }, order.id);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			kind: 'fulfillment-transition',
			actor: ADMIN.email,
			fromStatus: 'unfulfilled',
			toStatus: 'packed',
			note: 'raft 3'
		});
	});

	it('rejects an illegal transition with a typed error and writes NOTHING', async () => {
		const order = await insertOrder({});
		const result = await transitionFulfillment({ db }, order.id, 'delivered', {
			actor: ADMIN.email
		});
		expect(result).toEqual({
			ok: false,
			error: 'illegal-transition',
			from: 'unfulfilled',
			to: 'delivered'
		});
		const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(row.fulfillmentStatus).toBe('unfulfilled');
		expect(await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id))).toEqual(
			[]
		);
	});

	it('reports a missing order', async () => {
		expect(await transitionFulfillment({ db }, 'no-such-order', 'packed', { actor: 'x' })).toEqual({
			ok: false,
			error: 'not-found'
		});
	});

	it('walks the whole happy path and stops at the terminal state', async () => {
		const order = await insertOrder({});
		for (const to of ['packed', 'shipped', 'delivered', 'returned'] as const) {
			const step = await transitionFulfillment({ db }, order.id, to, { actor: ADMIN.email });
			expect(step.ok, `→ ${to} must be legal`).toBe(true);
		}
		// `returned` is terminal — the history preserves every step.
		const stuck = await transitionFulfillment({ db }, order.id, 'unfulfilled', {
			actor: ADMIN.email
		});
		expect(!stuck.ok && stuck.error).toBe('illegal-transition');
		expect(await listOrderEvents({ db }, order.id)).toHaveLength(4);
	});
});

describe('/admin/orders work queue', () => {
	let needsPacking: OrderRow;
	let packed: OrderRow;
	let shipped: OrderRow;
	let overSold: OrderRow;
	let pendingPayment: OrderRow;
	let refundedCancelled: OrderRow;

	beforeAll(async () => {
		await db.delete(orders); // isolate the queue fixtures from earlier describes
		needsPacking = await insertOrder({ status: 'paid', fulfillment: 'unfulfilled' });
		packed = await insertOrder({ status: 'paid', fulfillment: 'packed' });
		shipped = await insertOrder({ status: 'paid', fulfillment: 'shipped' });
		overSold = await insertOrder({ status: 'paid', fulfillment: 'unfulfilled', oversold: true });
		pendingPayment = await insertOrder({ status: 'pending', fulfillment: 'unfulfilled' });
		refundedCancelled = await insertOrder({ status: 'refunded', fulfillment: 'cancelled' });
	});

	it('defaults to the needs-action view: paid, not yet shipped — oversold included', async () => {
		const { filter, ids } = await loadIds('http://localhost/admin/orders');
		expect(filter).toBe('action');
		expect(ids).toEqual([needsPacking.id, packed.id, overSold.id].sort());
	});

	it('an unknown filter value falls back to the needs-action view', async () => {
		const { filter, ids } = await loadIds('http://localhost/admin/orders?f=nonsense');
		expect(filter).toBe('action');
		expect(ids).toEqual([needsPacking.id, packed.id, overSold.id].sort());
	});

	it('surfaces unresolved oversold orders under their own filter', async () => {
		const { ids } = await loadIds('http://localhost/admin/orders?f=oversold');
		expect(ids).toEqual([overSold.id]);
	});

	it('a resolved (shipped) oversold order leaves the oversold queue', async () => {
		await transitionFulfillment({ db }, overSold.id, 'packed', { actor: ADMIN.email });
		await transitionFulfillment({ db }, overSold.id, 'shipped', { actor: ADMIN.email });
		expect((await loadIds('http://localhost/admin/orders?f=oversold')).ids).toEqual([]);
		expect((await loadIds('http://localhost/admin/orders')).ids).toEqual(
			[needsPacking.id, packed.id].sort()
		);
	});

	it('filters by a single fulfillment status', async () => {
		expect((await loadIds('http://localhost/admin/orders?f=unfulfilled')).ids).toEqual(
			[needsPacking.id, pendingPayment.id].sort()
		);
		// The oversold fixture was shipped by the previous test, so it sits
		// alongside the always-shipped one here.
		expect((await loadIds('http://localhost/admin/orders?f=shipped')).ids).toEqual(
			[shipped.id, overSold.id].sort()
		);
		expect((await loadIds('http://localhost/admin/orders?f=cancelled')).ids).toEqual([
			refundedCancelled.id
		]);
	});

	it('`all` remains the full archive', async () => {
		const { ids } = await loadIds('http://localhost/admin/orders?f=all');
		expect(ids).toHaveLength(6);
	});

	it('listOrders defaults to the unfiltered archive for existing callers', async () => {
		expect(await listOrders({ db })).toHaveLength(6);
	});
});

describe('/admin/orders/[id] transition action', () => {
	it('admin: applies the transition, records the actor and note, and the load shows both', async () => {
		const order = await insertOrder({});
		const result = await transitionAction(
			transitionEvent(order.id, ADMIN, { to: 'packed', note: 'ambalat cu folie' })
		);
		expect(result).toEqual({ transitioned: true, to: 'packed' });

		const data = (await detailLoad({
			params: { id: order.id }
		} as Parameters<DetailPage['load']>[0])) as {
			order: OrderRow;
			events: Array<Record<string, unknown>>;
		};
		expect(data.order.fulfillmentStatus).toBe('packed');
		expect(data.events).toHaveLength(1);
		expect(data.events[0]).toMatchObject({
			kind: 'fulfillment-transition',
			actor: ADMIN.email,
			fromStatus: 'unfulfilled',
			toStatus: 'packed',
			note: 'ambalat cu folie'
		});
	});

	it('editor: 403 before anything is read or written', async () => {
		const order = await insertOrder({});
		try {
			await transitionAction(transitionEvent(order.id, EDITOR, { to: 'packed' }));
			expect.unreachable('the action must throw');
		} catch (err) {
			if (!isHttpError(err)) throw err;
			expect(err.status).toBe(403);
		}
		const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(row.fulfillmentStatus).toBe('unfulfilled');
		expect(await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id))).toEqual(
			[]
		);
	});

	it('an illegal transition is a 400 with the rejected endpoints, not a write', async () => {
		const order = await insertOrder({});
		const result = await transitionAction(transitionEvent(order.id, ADMIN, { to: 'delivered' }));
		if (!isActionFailure(result)) throw new Error('expected an ActionFailure');
		expect(result.status).toBe(400);
		expect(result.data).toEqual({
			error: 'illegal-transition',
			from: 'unfulfilled',
			to: 'delivered'
		});
		const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(row.fulfillmentStatus).toBe('unfulfilled');
	});

	it('an unknown target status is a 400', async () => {
		const order = await insertOrder({});
		const result = await transitionAction(transitionEvent(order.id, ADMIN, { to: 'teleported' }));
		if (!isActionFailure(result)) throw new Error('expected an ActionFailure');
		expect(result.status).toBe(400);
		expect(result.data).toEqual({ error: 'invalid-status' });
	});
});

describe('/admin/orders/[id] ?/issueInvoice — the one-click fiscal retry', () => {
	it('editor: 403 before anything is written', async () => {
		const order = await insertOrder({});
		try {
			await issueInvoiceAction({ params: { id: order.id }, locals: locals(EDITOR) });
			expect.unreachable('the action must throw');
		} catch (err) {
			if (!isHttpError(err)) throw err;
			expect(err.status).toBe(403);
		}
		expect(await db.select().from(invoices).where(eq(invoices.orderId, order.id))).toEqual([]);
	});

	it('admin without issuer settings: 400 with the failure recorded on the trail', async () => {
		const order = await insertOrder({});
		const result = await issueInvoiceAction({ params: { id: order.id }, locals: locals(ADMIN) });
		if (!isActionFailure(result)) throw new Error('expected an ActionFailure');
		expect(result.status).toBe(400);
		expect(result.data).toMatchObject({ invoiceError: 'settings-incomplete' });
		const trail = await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id));
		expect(trail.map((e) => e.kind)).toEqual(['invoice-failed']);
		expect(trail[0].actor).toBe(ADMIN.email);
	});

	it('admin with settings: issues the invoice, and the detail load returns it', async () => {
		await db
			.insert(siteSettings)
			.values(
				Object.entries({
					'company.legalName': 'Better Sleep SRL',
					'company.cui': 'RO12345678',
					'company.regCom': 'J40/1234/2025',
					'company.address': 'Str. Somnului 10, București',
					'invoice.seriesPrefix': 'QUE'
				}).map(([key, value]) => ({ key, value }))
			)
			.onConflictDoNothing();

		const order = await insertOrder({});
		const result = await issueInvoiceAction({ params: { id: order.id }, locals: locals(ADMIN) });
		expect(result).toEqual({ invoiceIssued: true });

		const data = (await detailLoad({
			params: { id: order.id }
		} as Parameters<DetailPage['load']>[0])) as {
			invoices: Array<{ kind: string; displayNumber: string }>;
			events: Array<Record<string, unknown>>;
		};
		expect(data.invoices).toHaveLength(1);
		expect(data.invoices[0]).toMatchObject({ kind: 'invoice', displayNumber: 'QUE-0001' });
		expect(data.events.some((e) => e.kind === 'invoice-issued')).toBe(true);
	});
});
