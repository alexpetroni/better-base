import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { isHttpError } from '@sveltejs/kit';
import { createDb, type Db } from '../../../lib/db/client.ts';
import { createEmailSender } from '../../../lib/modules/email/service.ts';
import { storageConfigFromEnv } from '../../../lib/modules/media/env.ts';
import { createStorage } from '../../../lib/modules/media/storage.ts';
import { createSettingsLoader } from '../../../lib/modules/settings/service.ts';
import type { MockCourierProvider } from '../../../lib/modules/shop/mock-courier.ts';
import { orders } from '../../../lib/modules/shop/schema.ts';
import { createShipmentForOrder } from '../../../lib/modules/shop/shipment-service.ts';

// The AWB label route on the REAL module against the real MinIO bucket:
// admin session in, everyone else out (labels are an operator artifact — no
// customer token variant exists on purpose), unknown shipment 404. The
// courier is the app's own singleton (the mock — COURIER_PROVIDER is unset
// under vitest), shared between the shipment created here and the route.

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
type Route = typeof import('./[id]/label/+server.ts');
let get: Route['GET'];
let shipmentId: string;
let awb: string;

const ADMIN = {
	id: 'lbl-admin',
	email: 'lbl-admin@example.com',
	name: 'A',
	role: 'admin' as const
};
const EDITOR = {
	id: 'lbl-editor',
	email: 'lbl-editor@example.com',
	name: 'E',
	role: 'editor' as const
};

function requestEvent(id: string, user: typeof ADMIN | typeof EDITOR | null) {
	return {
		params: { id },
		url: new URL(`http://localhost/api/shipments/${id}/label`),
		locals: { user, settings: createSettingsLoader(() => db) }
	} as unknown as Parameters<Route['GET']>[0];
}

async function statusOf(promise: Response | Promise<Response>): Promise<number> {
	try {
		return (await promise).status;
	} catch (err) {
		if (isHttpError(err)) return err.status;
		throw err;
	}
}

beforeAll(async () => {
	const url = process.env.TEST_DATABASE_URL;
	if (!url) throw new Error('TEST_DATABASE_URL is not set — see .env.example');
	db = createDb(url);
	await db.execute(sql`drop schema if exists public cascade`);
	await db.execute(sql`drop schema if exists drizzle cascade`);
	await db.execute(sql`create schema public`);
	await migrate(db, { migrationsFolder: path.resolve(import.meta.dirname, '../../../../drizzle') });
	await createStorage(storageConfigFromEnv(process.env)).ensureBucket();

	const [order] = await db
		.insert(orders)
		.values({
			id: 'lbl-order-1',
			email: 'client@example.ro',
			stripeSessionId: 'cs_lbl_1',
			amountTotalCents: 4990,
			currency: 'ron',
			status: 'paid',
			// The courier needs phone + county (FIX-11) before it registers an AWB.
			shippingAddress: {
				name: 'Ana Pop',
				phone: '+40723000111',
				line1: 'Str. Somnului 10',
				city: 'Cluj-Napoca',
				state: 'Cluj',
				postalCode: '400001',
				country: 'RO'
			}
		})
		.returning();

	// The shipment must be registered with the SAME courier instance the route
	// resolves (the server-barrel singleton), or getLabel would not know the AWB.
	const { getCourierProvider } = await import('../../../lib/modules/shop/server.ts');
	const created = await createShipmentForOrder(
		{
			db,
			courier: getCourierProvider(),
			email: createEmailSender({ db, dryRun: true, from: 'test@example.ro' }),
			siteName: 'Better Sleep'
		},
		order.id,
		'admin@example.ro'
	);
	if (!created.ok) throw new Error(`shipment setup failed: ${created.error}`);
	if (!created.value.shipment.awb) throw new Error('shipment setup failed: no AWB');
	shipmentId = created.value.shipment.id;
	awb = created.value.shipment.awb;

	get = (await import('./[id]/label/+server.ts')).GET;
});

afterAll(async () => {
	await db.$client.end();
});

describe('GET /api/shipments/[id]/label', () => {
	it('serves the admin the label PDF with download headers', async () => {
		const response = await get(requestEvent(shipmentId, ADMIN));
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/pdf');
		expect(response.headers.get('content-disposition')).toBe(
			`attachment; filename="AWB-${awb}.pdf"`
		);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
	});

	it('stores the label write-once: a second download works even if the courier forgot the AWB', async () => {
		const { getCourierProvider } = await import('../../../lib/modules/shop/server.ts');
		const courier = getCourierProvider() as MockCourierProvider;
		courier.shipments.delete(awb);
		const response = await get(requestEvent(shipmentId, ADMIN));
		expect(response.status).toBe(200);
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect(new TextDecoder().decode(bytes)).toContain(awb);
	});

	it('refuses editors and anonymous requests before touching anything', async () => {
		await expect(statusOf(get(requestEvent(shipmentId, EDITOR)))).resolves.toBe(403);
		// Anonymous is 401 (unauthenticated), not 403 — requireAdmin semantics.
		await expect(statusOf(get(requestEvent(shipmentId, null)))).resolves.toBe(401);
	});

	it('404s an unknown shipment', async () => {
		await expect(statusOf(get(requestEvent('no-such-shipment', ADMIN)))).resolves.toBe(404);
	});
});
