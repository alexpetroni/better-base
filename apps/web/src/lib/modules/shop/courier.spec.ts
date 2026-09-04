import { afterEach, describe, expect, it, vi } from 'vitest';
import { CourierAuthError, selectCourierProvider } from './courier.ts';
import { createMockCourierProvider, MOCK_TRACKING_URL_BASE } from './mock-courier.ts';
import {
	classifySamedayStatus,
	createSamedayCourier,
	normalizeSamedayStatus,
	SAMEDAY_STATUS_BY_ID,
	samedayTrackingUrl
} from './sameday-courier.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

// Provider selection is pure and mirrors the chat-provider rules: mock is the
// default, ambient credentials never activate the live adapter, a half-set
// live config is a hard error. No test anywhere constructs the Sameday
// adapter — vitest and playwright both run with the mock selected.

describe('selectCourierProvider', () => {
	it('selects the mock by default', () => {
		expect(selectCourierProvider({})).toEqual({ kind: 'mock' });
		expect(selectCourierProvider({ COURIER_PROVIDER: '' })).toEqual({ kind: 'mock' });
		expect(selectCourierProvider({ COURIER_PROVIDER: '  ' })).toEqual({ kind: 'mock' });
		expect(selectCourierProvider({ COURIER_PROVIDER: 'mock' })).toEqual({ kind: 'mock' });
	});

	it('ambient SAMEDAY_* credentials alone never activate the live adapter', () => {
		expect(
			selectCourierProvider({
				SAMEDAY_USERNAME: 'user',
				SAMEDAY_PASSWORD: 'secret',
				SAMEDAY_PICKUP_POINT: '123'
			})
		).toEqual({ kind: 'mock' });
	});

	it('sameday requires the full credential trio at boot', () => {
		expect(() => selectCourierProvider({ COURIER_PROVIDER: 'sameday' })).toThrow(/SAMEDAY_/);
		expect(() =>
			selectCourierProvider({ COURIER_PROVIDER: 'sameday', SAMEDAY_USERNAME: 'user' })
		).toThrow(/SAMEDAY_/);
		expect(() =>
			selectCourierProvider({
				COURIER_PROVIDER: 'sameday',
				SAMEDAY_USERNAME: 'user',
				SAMEDAY_PASSWORD: '  ',
				SAMEDAY_PICKUP_POINT: '123'
			})
		).toThrow(/SAMEDAY_/);

		expect(
			selectCourierProvider({
				COURIER_PROVIDER: 'sameday',
				SAMEDAY_USERNAME: 'user',
				SAMEDAY_PASSWORD: 'secret',
				SAMEDAY_PICKUP_POINT: '123',
				SAMEDAY_BASE_URL: 'https://api.sameday.ro/'
			})
		).toMatchObject({ kind: 'sameday', username: 'user', pickupPoint: '123' });
	});

	it('refuses unknown provider names', () => {
		expect(() => selectCourierProvider({ COURIER_PROVIDER: 'cargus' })).toThrow(
			/Unknown COURIER_PROVIDER/
		);
	});
});

describe('mock courier provider', () => {
	it('registers deterministic AWBs and serves label, tracking and cancel from memory', async () => {
		const courier = createMockCourierProvider();
		const created = await courier.createShipment({
			orderId: 'order-1',
			reference: 'order-1',
			recipient: { name: 'Ana Pop', email: 'ana@example.ro', address: { city: 'Cluj-Napoca' } }
		});
		expect(created.awb).toBe('MOCKAWB000001');
		expect(created.trackingUrl).toBe(`${MOCK_TRACKING_URL_BASE}/MOCKAWB000001`);

		// The label is a real (minimal) PDF embedding the AWB, byte-deterministic.
		const label = await courier.getLabel(created.awb);
		expect(label).not.toBeNull();
		const text = new TextDecoder().decode(label!);
		expect(text.startsWith('%PDF-1.4')).toBe(true);
		expect(text).toContain('MOCKAWB000001');
		expect(await courier.getLabel(created.awb)).toEqual(label);

		// Tracking never advances on its own — tests drive it explicitly.
		expect(await courier.trackShipment(created.awb)).toBe('registered');
		courier.setTrackingStatus(created.awb, 'in-transit');
		expect(await courier.trackShipment(created.awb)).toBe('in-transit');

		// Unknown AWBs are null, not errors (the cron sync skips them).
		expect(await courier.trackShipment('AWB-UNKNOWN')).toBeNull();
		expect(await courier.getLabel('AWB-UNKNOWN')).toBeNull();
	});

	it('cancels only not-yet-picked-up shipments', async () => {
		const courier = createMockCourierProvider();
		const first = await courier.createShipment({
			orderId: 'o1',
			reference: 'o1',
			recipient: { name: 'A', email: 'a@example.ro', address: {} }
		});
		await courier.cancelShipment(first.awb);
		expect(courier.cancelled).toEqual([first.awb]);
		expect(await courier.trackShipment(first.awb)).toBe('cancelled');

		const second = await courier.createShipment({
			orderId: 'o2',
			reference: 'o2',
			recipient: { name: 'B', email: 'b@example.ro', address: {} }
		});
		courier.setTrackingStatus(second.awb, 'in-transit');
		await expect(courier.cancelShipment(second.awb)).rejects.toThrow(/already picked up/);
		await expect(courier.cancelShipment('AWB-UNKNOWN')).rejects.toThrow(/no shipment/);
	});

	it('trackFailures makes a tracking call throw (the sync-rotation test seam)', async () => {
		const courier = createMockCourierProvider();
		const created = await courier.createShipment({
			orderId: 'o3',
			reference: 'o3',
			recipient: { name: 'C', email: 'c@example.ro', address: {} }
		});
		courier.trackFailures.set(created.awb, new Error('boom'));
		await expect(courier.trackShipment(created.awb)).rejects.toThrow('boom');
		courier.trackFailures.delete(created.awb);
		expect(await courier.trackShipment(created.awb)).toBe('registered');
	});
});

/**
 * The Sameday adapter against a scripted fetch: never a network call. The
 * responder answers /api/authenticate with a token and everything else with
 * what the test scripted; every request body is recorded for inspection.
 */
function samedayHarness(respond: (path: string, init: RequestInit) => Response) {
	const requests: Array<{ path: string; body: URLSearchParams }> = [];
	const fetchFn: typeof fetch = async (url, init) => {
		const path = new URL(String(url)).pathname;
		requests.push({ path, body: new URLSearchParams(String(init?.body ?? '')) });
		if (path === '/api/authenticate') {
			return Response.json({ token: 'tok', expire_at_utc: '2099-01-01T00:00:00Z' });
		}
		return respond(path, init ?? {});
	};
	const courier = createSamedayCourier({
		username: 'user',
		password: 'secret',
		pickupPoint: '42',
		fetchFn
	});
	return { courier, requests };
}

const RECIPIENT = {
	name: 'Ana Pop',
	email: 'ana@example.ro',
	phone: '+40723000111',
	address: {
		name: 'Ana Pop',
		line1: 'Str. Somnului 10',
		city: 'Cluj-Napoca',
		state: 'Cluj',
		postalCode: '400001',
		country: 'RO'
	}
};

// Audit 2026-09-03 P1 "Sameday adapter": the 400 body — Sameday's actual
// reason — was discarded, and a missing county silently became the city.
describe('sameday adapter (offline, through the fetch seam)', () => {
	it('an AWB refusal carries the response body so the operator sees the reason', async () => {
		const { courier } = samedayHarness(
			() =>
				new Response(
					JSON.stringify({
						errors: {
							children: {
								awbRecipient: {
									children: { phoneNumber: { errors: ['This value should not be blank.'] } }
								}
							}
						}
					}),
					{ status: 400, headers: { 'content-type': 'application/json' } }
				)
		);
		await expect(
			courier.createShipment({ orderId: 'o1', reference: 'o1', recipient: RECIPIENT })
		).rejects.toThrow(/HTTP 400.*phoneNumber.*should not be blank/s);
	});

	it('bounds a huge error body instead of echoing it whole', async () => {
		const { courier } = samedayHarness(() => new Response('x'.repeat(10_000), { status: 500 }));
		await expect(
			courier.createShipment({ orderId: 'o1', reference: 'o1', recipient: RECIPIENT })
		).rejects.toSatisfy((err: unknown) => err instanceof Error && err.message.length < 1_000);
	});

	it('sends phone, county (from the address state) and the order id as the client reference', async () => {
		const { courier, requests } = samedayHarness(() => Response.json({ awbNumber: '1SD42' }));
		const created = await courier.createShipment({
			orderId: 'order-77',
			reference: 'order-77',
			recipient: RECIPIENT
		});
		expect(created.awb).toBe('1SD42');
		const awb = requests.find((r) => r.path === '/api/awb');
		expect(awb).toBeDefined();
		expect(awb!.body.get('awbRecipient[phoneNumber]')).toBe('+40723000111');
		expect(awb!.body.get('awbRecipient[countyString]')).toBe('Cluj');
		expect(awb!.body.get('awbRecipient[cityString]')).toBe('Cluj-Napoca');
		expect(awb!.body.get('clientInternalReference')).toBe('order-77');
	});

	it('a rejected login is a CourierAuthError, and so is a 401 on a later call', async () => {
		const noLogin = createSamedayCourier({
			username: 'user',
			password: 'wrong',
			pickupPoint: '42',
			fetchFn: async () => new Response('{"message":"Bad credentials"}', { status: 401 })
		});
		await expect(noLogin.trackShipment('1SD1')).rejects.toBeInstanceOf(CourierAuthError);
		await expect(noLogin.trackShipment('1SD1')).rejects.toThrow(/Bad credentials/);

		const expired = samedayHarness(() => new Response('token expired', { status: 401 }));
		await expect(expired.courier.trackShipment('1SD1')).rejects.toBeInstanceOf(CourierAuthError);
		// A plain server error is NOT an auth error — it must not abort the sync.
		const down = samedayHarness(() => new Response('gateway timeout', { status: 504 }));
		const err = await down.courier.trackShipment('1SD1').catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(CourierAuthError);
	});

	it('classifies a tracking response by statusId first, then by text', async () => {
		const byId = samedayHarness(() =>
			Response.json({ expeditionStatus: { statusId: 1, status: 'AWB Emis', statusState: 'Emis' } })
		);
		expect(await byId.courier.trackShipment('1SD1')).toBe('registered');
		const undelivered = samedayHarness(() =>
			Response.json({ expeditionStatus: { statusId: 9999, status: 'Colet nelivrat' } })
		);
		expect(await undelivered.courier.trackShipment('1SD1')).toBe('in-transit');
		const empty = samedayHarness(() => Response.json({ expeditionStatus: {} }));
		expect(await empty.courier.trackShipment('1SD1')).toBeNull();
	});

	it('never substitutes the city for a missing county', async () => {
		const { courier, requests } = samedayHarness(() => Response.json({ awbNumber: '1SD43' }));
		await courier.createShipment({
			orderId: 'order-78',
			reference: 'order-78',
			recipient: { ...RECIPIENT, address: { ...RECIPIENT.address, state: undefined } }
		});
		const awb = requests.find((r) => r.path === '/api/awb');
		expect(awb!.body.get('awbRecipient[countyString]')).toBe('');
		expect(awb!.body.get('awbRecipient[cityString]')).toBe('Cluj-Napoca');
	});
});

// Audit 2026-09-03 P1 "Status classification by substring": `includes('livrat')`
// matched "nelivrat", so an undelivered parcel read as delivered.
describe('sameday status classification (pure, offline)', () => {
	it('a known statusId wins, whatever the text says', () => {
		expect(SAMEDAY_STATUS_BY_ID[1]).toBe('registered');
		expect(classifySamedayStatus({ statusId: 1, status: 'AWB Emis' })).toBe('registered');
		expect(classifySamedayStatus({ statusId: '1', status: 'Livrat' })).toBe('registered');
	});

	it('falls back to anchored text with explicit negatives', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(classifySamedayStatus({ statusId: 9999, status: 'Nelivrat' })).toBe('in-transit');
		expect(classifySamedayStatus({ status: 'Colet nelivrat - client absent' })).toBe('in-transit');
		expect(classifySamedayStatus({ statusState: 'Livrat' })).toBe('delivered');
		expect(classifySamedayStatus({ status: 'Livrată cu succes' })).toBe('delivered');
		expect(classifySamedayStatus({ status: 'Anulat' })).toBe('cancelled');
		expect(classifySamedayStatus({ status: 'AWB anulat' })).toBe('cancelled');
		expect(classifySamedayStatus({ status: 'În tranzit' })).toBe('in-transit');
		expect(classifySamedayStatus({ status: 'Ieșit la livrare' })).toBe('in-transit');
		expect(classifySamedayStatus({ status: 'Retur la expeditor' })).toBe('returned');
		expect(classifySamedayStatus({ status: 'AWB Emis' })).toBe('registered');
		// Known vocabulary never warns.
		expect(warn).not.toHaveBeenCalled();
	});

	it('an unknown text maps to in-transit and warns with the raw payload', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const payload = { statusId: 777, status: 'Stare complet nouă', statusState: 'Nouă' };
		expect(classifySamedayStatus(payload)).toBe('in-transit');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0][0])).toContain('777');
		expect(String(warn.mock.calls[0][0])).toContain('Stare complet nouă');
	});

	it('normalizeSamedayStatus keeps the text-only shape and no longer reads nelivrat as livrat', () => {
		expect(normalizeSamedayStatus('Nelivrat')).toBe('in-transit');
		expect(normalizeSamedayStatus('nelivrat - adresa gresita')).toBe('in-transit');
	});
});

describe('sameday status normalization (pure, offline)', () => {
	it('maps the Romanian status vocabulary onto the normalized states', () => {
		expect(normalizeSamedayStatus('AWB Emis')).toBe('registered');
		expect(normalizeSamedayStatus('Colet creat')).toBe('registered');
		expect(normalizeSamedayStatus('In tranzit')).toBe('in-transit');
		expect(normalizeSamedayStatus('Iesit la livrare')).toBe('in-transit');
		expect(normalizeSamedayStatus('Livrat')).toBe('delivered');
		expect(normalizeSamedayStatus('Livrata cu succes')).toBe('delivered');
		expect(normalizeSamedayStatus('Retur la expeditor')).toBe('returned');
		expect(normalizeSamedayStatus('Anulat')).toBe('cancelled');
		// Unknown movement text defaults to in-transit, never a terminal state.
		expect(normalizeSamedayStatus('Sortare hub')).toBe('in-transit');
	});

	it('builds the public tracking URL per AWB', () => {
		expect(samedayTrackingUrl('1SD123')).toBe('https://sameday.ro/#awb=1SD123');
	});
});
