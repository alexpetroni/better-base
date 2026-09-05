import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
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
import { invoiceLines, invoices } from '../../../../lib/modules/invoice/schema.ts';
import { siteSettings } from '../../../../lib/modules/settings/schema.ts';
import {
	orderEvents,
	orderItems,
	orders,
	shipments,
	type OrderRow,
	type ShippingAddress
} from '../../../../lib/modules/shop/schema.ts';
import { listOrders } from '../../../../lib/modules/shop/webhook.ts';
import { ISSUER_ADDRESS_SETTINGS } from '../../../../../tests/helpers/issuer-settings.ts';

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
let generateAwbAction: (event: { params: { id: string }; locals: App.Locals }) => Promise<unknown>;
let stornoPartialAction: (event: {
	params: { id: string };
	locals: App.Locals;
}) => Promise<unknown>;
let updateShippingAddressAction: (event: {
	request: Request;
	params: { id: string };
	locals: App.Locals;
}) => Promise<unknown>;

function locals(user: typeof ADMIN | typeof EDITOR | null): App.Locals {
	return { user, settings: createSettingsLoader(() => db), requestId: 'spec' };
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
	/** Stripe's cumulative refunded amount, as the webhook would have recorded it. */
	refundedCents?: number;
	/** Item snapshots (the invoice lines derive from them); none by default. */
	items?: Array<{ name: string; qty: number; priceCents: number }>;
	/** Delivery address as the webhook stored it; none by default. */
	shippingAddress?: ShippingAddress;
}): Promise<OrderRow> {
	orderSeq += 1;
	const items = input.items ?? [];
	const [row] = await db
		.insert(orders)
		.values({
			id: `order-q-${orderSeq}`,
			email: `client${orderSeq}@example.ro`,
			stripeSessionId: `cs_queue_${orderSeq}`,
			amountTotalCents: items.length
				? items.reduce((sum, item) => sum + item.qty * item.priceCents, 0)
				: 4990,
			currency: 'ron',
			status: input.status ?? 'paid',
			fulfillmentStatus: input.fulfillment ?? 'unfulfilled',
			oversold: input.oversold ?? false,
			refundedCents: input.refundedCents ?? 0,
			shippingAddress: input.shippingAddress ?? null
		})
		.returning();
	if (items.length) {
		await db
			.insert(orderItems)
			.values(items.map((item, i) => ({ id: `${row.id}-item-${i}`, orderId: row.id, ...item })));
	}
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
	generateAwbAction = detailPage.actions.generateAwb as unknown as typeof generateAwbAction;
	stornoPartialAction = detailPage.actions.stornoPartial as unknown as typeof stornoPartialAction;
	updateShippingAddressAction = detailPage.actions
		.updateShippingAddress as unknown as typeof updateShippingAddressAction;
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
					'company.cui': 'RO12345676',
					'company.vatRegistered': true,
					'company.regCom': 'J40/1234/2025',
					'company.address': 'Str. Somnului 10, București',
					...ISSUER_ADDRESS_SETTINGS,
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

describe('/admin/orders/[id] ?/transition — the sync-only edge is not operator-reachable', () => {
	it('shipped → packed by an admin is an illegal transition (400), the order stays shipped', async () => {
		const order = await insertOrder({ fulfillment: 'shipped' });
		const result = await transitionAction(transitionEvent(order.id, ADMIN, { to: 'packed' }));
		if (!isActionFailure(result)) throw new Error('expected an ActionFailure');
		expect(result.status).toBe(400);
		expect(result.data).toMatchObject({
			error: 'illegal-transition',
			from: 'shipped',
			to: 'packed'
		});
		const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(row.fulfillmentStatus).toBe('shipped');
	});
});

/** Everything the courier needs: phone and county included (FIX-11). */
const RECIPIENT: ShippingAddress = {
	name: 'Ana Pop',
	phone: '+40723000111',
	line1: 'Str. Somnului 10',
	city: 'Cluj-Napoca',
	state: 'Cluj',
	postalCode: '400001',
	country: 'RO'
};

describe('/admin/orders/[id] ?/generateAwb — courier AWB from the detail page', () => {
	it('editor: 403 before anything is written', async () => {
		const order = await insertOrder({ shippingAddress: RECIPIENT });
		try {
			await generateAwbAction({ params: { id: order.id }, locals: locals(EDITOR) });
			expect.unreachable('the action must throw');
		} catch (err) {
			if (!isHttpError(err)) throw err;
			expect(err.status).toBe(403);
		}
		expect(await db.select().from(shipments).where(eq(shipments.orderId, order.id))).toEqual([]);
		const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(row.fulfillmentStatus).toBe('unfulfilled');
	});

	it('admin: registers the AWB via the (mock) courier, ships the order, and a re-click is a no-op', async () => {
		const order = await insertOrder({ shippingAddress: RECIPIENT });
		const result = await generateAwbAction({ params: { id: order.id }, locals: locals(ADMIN) });
		expect(result).toEqual({ awbGenerated: true, awbExisting: false });

		const data = (await detailLoad({
			params: { id: order.id }
		} as Parameters<DetailPage['load']>[0])) as {
			order: OrderRow;
			shipment: { awb: string; trackingUrl: string; status: string } | null;
			events: Array<Record<string, unknown>>;
		};
		expect(data.order.fulfillmentStatus).toBe('shipped');
		expect(data.shipment).not.toBeNull();
		expect(data.shipment!.awb).toMatch(/^MOCKAWB/);
		expect(data.shipment!.trackingUrl).toContain(data.shipment!.awb);
		expect(data.events.some((e) => e.kind === 'awb-generated')).toBe(true);

		const again = await generateAwbAction({ params: { id: order.id }, locals: locals(ADMIN) });
		expect(again).toEqual({ awbGenerated: true, awbExisting: true });
		expect(await db.select().from(shipments).where(eq(shipments.orderId, order.id))).toHaveLength(
			1
		);
	});

	it('an unpaid order is a 400, not a shipment', async () => {
		const order = await insertOrder({ status: 'pending', shippingAddress: RECIPIENT });
		const result = await generateAwbAction({ params: { id: order.id }, locals: locals(ADMIN) });
		if (!isActionFailure(result)) throw new Error('expected an ActionFailure');
		expect(result.status).toBe(400);
		expect(result.data).toMatchObject({ awbError: 'order-not-paid' });
		expect(await db.select().from(shipments).where(eq(shipments.orderId, order.id))).toEqual([]);
	});

	// Audit 2026-09-03 P1 "Sameday adapter": an order without a phone or
	// county must be refused with the fields named, not sent to the courier.
	it('missing recipient data is a 400 naming the fields — no courier call, no shipment', async () => {
		const order = await insertOrder({
			shippingAddress: { name: 'Ana Pop', line1: 'Str. Somnului 10', city: 'Cluj-Napoca' }
		});
		const result = await generateAwbAction({ params: { id: order.id }, locals: locals(ADMIN) });
		if (!isActionFailure(result)) throw new Error('expected an ActionFailure');
		expect(result.status).toBe(400);
		expect(result.data).toMatchObject({ awbError: 'missing-recipient-data' });
		expect(
			String((result.data as unknown as { awbDetail: string }).awbDetail)
				.split(', ')
				.sort()
		).toEqual(['county', 'phone']);
		expect(await db.select().from(shipments).where(eq(shipments.orderId, order.id))).toEqual([]);
		const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(row.fulfillmentStatus).toBe('unfulfilled');
	});

	// FIX-11: a refused AWB is not a dead end — the row is `failed` with the
	// courier's reason, the page shows it, and the next click retries.
	it('a courier refusal is a 400 with the reason; the re-click registers the AWB', async () => {
		const order = await insertOrder({ shippingAddress: RECIPIENT });
		const { getCourierProvider } = await import('../../../../lib/modules/shop/server.ts');
		const courier =
			getCourierProvider() as import('../../../../lib/modules/shop/mock-courier.ts').MockCourierProvider;
		courier.failNextCreate = new Error('Sameday AWB creation failed (HTTP 400): county unknown');

		const refused = await generateAwbAction({ params: { id: order.id }, locals: locals(ADMIN) });
		if (!isActionFailure(refused)) throw new Error('expected an ActionFailure');
		expect(refused.status).toBe(400);
		expect(refused.data).toMatchObject({ awbError: 'courier' });
		expect(String((refused.data as unknown as { awbDetail: string }).awbDetail)).toContain(
			'county unknown'
		);
		let data = (await detailLoad({
			params: { id: order.id }
		} as Parameters<DetailPage['load']>[0])) as {
			order: OrderRow;
			shipment: { status: string; awb: string | null; lastError: string | null } | null;
		};
		expect(data.order.fulfillmentStatus).toBe('unfulfilled');
		expect(data.shipment).toMatchObject({ status: 'failed', awb: null });
		expect(data.shipment!.lastError).toContain('county unknown');

		const retry = await generateAwbAction({ params: { id: order.id }, locals: locals(ADMIN) });
		expect(retry).toEqual({ awbGenerated: true, awbExisting: false });
		data = (await detailLoad({
			params: { id: order.id }
		} as Parameters<DetailPage['load']>[0])) as typeof data;
		expect(data.order.fulfillmentStatus).toBe('shipped');
		expect(data.shipment!.status).toBe('registered');
		expect(data.shipment!.awb).toMatch(/^MOCKAWB/);
	});
});

function addressEvent(
	orderId: string,
	user: typeof ADMIN | typeof EDITOR | null,
	fields: Record<string, string>
): { request: Request; params: { id: string }; locals: App.Locals } {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) body.set(key, value);
	return {
		request: new Request(`http://localhost/admin/orders/${orderId}?/updateShippingAddress`, {
			method: 'POST',
			body
		}),
		params: { id: orderId },
		locals: locals(user)
	};
}

// FIX-11: the way out of `missing-recipient-data` — orders placed before phone
// collection existed, or whose Stripe address lacks a county, get the data
// typed in by the operator (admin-only, trail event without the values).
describe('/admin/orders/[id] ?/updateShippingAddress — recipient data for the courier', () => {
	const FORM = {
		name: 'Ana Pop',
		phone: '+40 723 000 111',
		line1: 'Str. Somnului 10',
		line2: '',
		city: 'Cluj-Napoca',
		state: 'Cluj',
		postalCode: '400001',
		country: 'ro'
	};

	it('editor: 403 before anything is written', async () => {
		const order = await insertOrder({
			shippingAddress: { name: 'Ana Pop', line1: 'Str. Somnului 10', city: 'Cluj-Napoca' }
		});
		try {
			await updateShippingAddressAction(addressEvent(order.id, EDITOR, FORM));
			expect.unreachable('the action must throw');
		} catch (err) {
			if (!isHttpError(err)) throw err;
			expect(err.status).toBe(403);
		}
		const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(row.shippingAddress?.phone).toBeUndefined();
	});

	it('admin: fills in phone and county, the trail names the changed fields only, and the AWB then succeeds', async () => {
		const order = await insertOrder({
			shippingAddress: { name: 'Ana Pop', line1: 'Str. Somnului 10', city: 'Cluj-Napoca' }
		});
		const result = await updateShippingAddressAction(addressEvent(order.id, ADMIN, FORM));
		expect(result).toEqual({ addressUpdated: true });

		const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(row.shippingAddress).toEqual({
			name: 'Ana Pop',
			phone: '+40 723 000 111',
			line1: 'Str. Somnului 10',
			city: 'Cluj-Napoca',
			state: 'Cluj',
			postalCode: '400001',
			country: 'RO'
		});
		const events = await listOrderEvents({ db }, order.id);
		const edit = events.find((e) => e.kind === 'shipping-address-updated');
		expect(edit?.actor).toBe(ADMIN.email);
		expect(edit?.note.split(', ').sort()).toEqual(['country', 'phone', 'postalCode', 'state']);
		expect(edit?.note).not.toContain('723');

		const awb = await generateAwbAction({ params: { id: order.id }, locals: locals(ADMIN) });
		expect(awb).toEqual({ awbGenerated: true, awbExisting: false });
	});

	it('refuses an address the courier still could not use, naming the fields', async () => {
		const order = await insertOrder({ shippingAddress: RECIPIENT });
		const result = await updateShippingAddressAction(
			addressEvent(order.id, ADMIN, { ...FORM, phone: '   ', state: '' })
		);
		if (!isActionFailure(result)) throw new Error('expected an ActionFailure');
		expect(result.status).toBe(400);
		expect(result.data).toMatchObject({ addressError: 'missing-recipient-data' });
		expect(
			String((result.data as unknown as { addressDetail: string }).addressDetail)
				.split(', ')
				.sort()
		).toEqual(['county', 'phone']);
		// Nothing written.
		const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(row.shippingAddress).toEqual(RECIPIENT);
	});

	it('unknown order is a 404', async () => {
		try {
			await updateShippingAddressAction(addressEvent('no-such-order', ADMIN, FORM));
			expect.unreachable('the action must throw');
		} catch (err) {
			if (!isHttpError(err)) throw err;
			expect(err.status).toBe(404);
		}
	});
});

describe('/admin/orders/[id] ?/stornoPartial — the fiscal side of a partial refund (FIX-10)', () => {
	beforeAll(async () => {
		await db
			.insert(siteSettings)
			.values(
				Object.entries({
					'company.legalName': 'Better Sleep SRL',
					'company.cui': 'RO12345676',
					'company.vatRegistered': true,
					'company.regCom': 'J40/1234/2025',
					'company.address': 'Str. Somnului 10, București',
					...ISSUER_ADDRESS_SETTINGS,
					'invoice.seriesPrefix': 'QUE',
					'invoice.vatStandardRates': '2025-08-01 21'
				}).map(([key, value]) => ({ key, value }))
			)
			.onConflictDoNothing();
	});

	async function docsOf(orderId: string) {
		return db
			.select()
			.from(invoices)
			.where(eq(invoices.orderId, orderId))
			.orderBy(asc(invoices.number));
	}

	it('editor: 403 before anything is written', async () => {
		const order = await insertOrder({
			refundedCents: 1500,
			items: [{ name: 'Pernă', qty: 2, priceCents: 4990 }]
		});
		await issueInvoiceAction({ params: { id: order.id }, locals: locals(ADMIN) });
		try {
			await stornoPartialAction({ params: { id: order.id }, locals: locals(EDITOR) });
			expect.unreachable('the action must throw');
		} catch (err) {
			if (!isHttpError(err)) throw err;
			expect(err.status).toBe(403);
		}
		expect((await docsOf(order.id)).map((d) => d.kind)).toEqual(['invoice']);
	});

	it('admin: reverses exactly the refunded-but-unreversed amount as one line at the original rate; a second click has nothing to storno', async () => {
		// Stripe refunded 15,00 lei of a 99,80 lei order (the webhook recorded it).
		const order = await insertOrder({
			refundedCents: 1500,
			items: [{ name: 'Pernă', qty: 2, priceCents: 4990 }]
		});
		await issueInvoiceAction({ params: { id: order.id }, locals: locals(ADMIN) });

		const result = await stornoPartialAction({ params: { id: order.id }, locals: locals(ADMIN) });
		expect(result).toEqual({ stornoIssued: true });

		const docs = await docsOf(order.id);
		expect(docs.map((d) => d.kind)).toEqual(['invoice', 'storno']);
		const [original, storno] = docs;
		expect(storno.stornoOfInvoiceId).toBe(original.id);
		// Gross = the refunded amount; VAT extracted at 21%: 1500 → 260 VAT, 1240 net.
		expect(storno.grossTotalCents).toBe(-1500);
		expect(storno.vatTotalCents).toBe(-260);
		expect(storno.netTotalCents).toBe(-1240);
		const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, storno.id));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			qty: -1,
			unitPriceCents: 1500,
			vatRateBp: 2100,
			grossCents: -1500,
			vatCents: -260,
			netCents: -1240
		});
		expect(lines[0].description).toContain(original.displayNumber);
		// The original is untouched and the order stays paid.
		const [after] = await db.select().from(orders).where(eq(orders.id, order.id));
		expect(after.status).toBe('paid');
		expect(after.refundedCents).toBe(1500);
		const trail = await db.select().from(orderEvents).where(eq(orderEvents.orderId, order.id));
		expect(trail.some((e) => e.kind === 'storno-issued' && e.actor === ADMIN.email)).toBe(true);

		// Nothing left to reverse: the second click is a typed 400, not a document.
		const again = await stornoPartialAction({ params: { id: order.id }, locals: locals(ADMIN) });
		if (!isActionFailure(again)) throw new Error('expected an ActionFailure');
		expect(again.status).toBe(400);
		expect(again.data).toMatchObject({ stornoError: 'nothing-to-storno' });
		expect(await docsOf(order.id)).toHaveLength(2);

		// A later, larger cumulative refund reverses only the difference.
		await db.update(orders).set({ refundedCents: 4000 }).where(eq(orders.id, order.id));
		expect(await stornoPartialAction({ params: { id: order.id }, locals: locals(ADMIN) })).toEqual({
			stornoIssued: true
		});
		const three = await docsOf(order.id);
		expect(three.map((d) => d.grossTotalCents)).toEqual([9980, -1500, -2500]);
	});

	it('an order without a refund or without an invoice is a typed 400', async () => {
		const noRefund = await insertOrder({ items: [{ name: 'Pernă', qty: 1, priceCents: 4990 }] });
		await issueInvoiceAction({ params: { id: noRefund.id }, locals: locals(ADMIN) });
		const a = await stornoPartialAction({ params: { id: noRefund.id }, locals: locals(ADMIN) });
		if (!isActionFailure(a)) throw new Error('expected an ActionFailure');
		expect(a.data).toMatchObject({ stornoError: 'nothing-to-storno' });

		const noInvoice = await insertOrder({
			refundedCents: 1000,
			items: [{ name: 'Pernă', qty: 1, priceCents: 4990 }]
		});
		const b = await stornoPartialAction({ params: { id: noInvoice.id }, locals: locals(ADMIN) });
		if (!isActionFailure(b)) throw new Error('expected an ActionFailure');
		expect(b.data).toMatchObject({ stornoError: 'no-invoice-to-reverse' });
		expect(await docsOf(noInvoice.id)).toEqual([]);
	});

	it('work queue: a partially refunded order stays in the action view and the row carries the amount', async () => {
		const order = await insertOrder({
			refundedCents: 1500,
			items: [{ name: 'Pernă', qty: 2, priceCents: 4990 }]
		});
		const { ids } = await loadIds('http://localhost/admin/orders');
		expect(ids).toContain(order.id);
		const row = (await listOrders({ db }, 'action')).find((o) => o.id === order.id);
		expect(row?.refundedCents).toBe(1500);
		expect(row?.status).toBe('paid');
	});
});
