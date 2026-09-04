import type { ShippingAddress } from './schema.ts';

/**
 * The courier surface the shop uses, as an interface so tests and dev inject a
 * deterministic mock (the `StripeGateway` pattern). The REAL implementation —
 * Sameday, chosen because it is Romania's largest e-commerce courier and has a
 * public token-authenticated REST API — lives in `sameday-courier.ts`; the
 * mock in `mock-courier.ts`. Nothing outside those two files talks to a
 * courier API, and the interface is provider-agnostic: a Cargus adapter would
 * implement the same four calls.
 */

/** What the courier needs to register an AWB for an order. */
export interface ShipmentRequest {
	orderId: string;
	/** Short human reference printed on the AWB (e.g. the order id). */
	reference: string;
	recipient: {
		name: string;
		email: string;
		phone?: string;
		address: ShippingAddress;
	};
}

export interface CreatedShipment {
	awb: string;
	/** Public tracking page for this AWB. */
	trackingUrl: string;
}

/**
 * Courier tracking states, normalized by each adapter from the provider's own
 * vocabulary. `registered` = AWB exists, parcel not yet picked up.
 */
export type CourierTrackingStatus =
	'registered' | 'in-transit' | 'delivered' | 'returned' | 'cancelled';

/**
 * The courier rejected the CREDENTIALS (login refused, or a 401/403 on a
 * call): no AWB is at fault, so the status sync aborts the whole run instead
 * of backing every row off one by one. Checked by name as well as by class so
 * it survives duplicated module instances.
 */
export class CourierAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CourierAuthError';
	}
}

export function isCourierAuthError(err: unknown): err is CourierAuthError {
	return (
		err instanceof CourierAuthError || (err instanceof Error && err.name === 'CourierAuthError')
	);
}

export interface CourierProvider {
	/** Stable adapter id stored on the shipment row (`mock` | `sameday`). */
	readonly name: string;
	createShipment(request: ShipmentRequest): Promise<CreatedShipment>;
	/** The AWB label PDF bytes; null when the provider cannot produce one. */
	getLabel(awb: string): Promise<Uint8Array | null>;
	/** Current tracking status; null for an AWB the provider does not know. */
	trackShipment(awb: string): Promise<CourierTrackingStatus | null>;
	/** Cancel a not-yet-picked-up AWB. Throws when the courier refuses. */
	cancelShipment(awb: string): Promise<void>;
}

export type CourierSelection =
	| { kind: 'mock' }
	| { kind: 'sameday'; username: string; password: string; pickupPoint: string; baseUrl?: string };

/**
 * Pure selection (the `selectChatProvider` pattern): the mock is the default,
 * ambient SAMEDAY_* credentials alone never activate the live adapter, and
 * asking for it without complete credentials is a hard boot error — never a
 * silent fallback. Dev, vitest and e2e therefore always run on the mock.
 */
export function selectCourierProvider(env: {
	COURIER_PROVIDER?: string;
	SAMEDAY_USERNAME?: string;
	SAMEDAY_PASSWORD?: string;
	SAMEDAY_PICKUP_POINT?: string;
	SAMEDAY_BASE_URL?: string;
}): CourierSelection {
	const requested = env.COURIER_PROVIDER?.trim() || 'mock';
	if (requested === 'mock') return { kind: 'mock' };
	if (requested === 'sameday') {
		const username = env.SAMEDAY_USERNAME?.trim() ?? '';
		const password = env.SAMEDAY_PASSWORD?.trim() ?? '';
		const pickupPoint = env.SAMEDAY_PICKUP_POINT?.trim() ?? '';
		if (!username || !password || !pickupPoint) {
			throw new Error(
				'COURIER_PROVIDER=sameday requires SAMEDAY_USERNAME, SAMEDAY_PASSWORD and ' +
					'SAMEDAY_PICKUP_POINT — see .env.example'
			);
		}
		return {
			kind: 'sameday',
			username,
			password,
			pickupPoint,
			...(env.SAMEDAY_BASE_URL?.trim() ? { baseUrl: env.SAMEDAY_BASE_URL.trim() } : {})
		};
	}
	throw new Error(`Unknown COURIER_PROVIDER "${requested}" — use "mock" or "sameday"`);
}
