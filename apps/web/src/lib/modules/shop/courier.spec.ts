import { describe, expect, it } from 'vitest';
import { selectCourierProvider } from './courier.ts';
import { createMockCourierProvider, MOCK_TRACKING_URL_BASE } from './mock-courier.ts';
import { normalizeSamedayStatus, samedayTrackingUrl } from './sameday-courier.ts';

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
