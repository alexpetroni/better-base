import type { CourierProvider, CourierTrackingStatus, ShipmentRequest } from './courier.ts';

/** Default per-request cap; override via SAMEDAY_TIMEOUT_MS. */
export const SAMEDAY_TIMEOUT_MS_DEFAULT = 15_000;
export const SAMEDAY_BASE_URL_DEFAULT = 'https://api.sameday.ro';
/** Sameday service id for standard 24h delivery; override via SAMEDAY_SERVICE_ID. */
export const SAMEDAY_SERVICE_ID_DEFAULT = 7;
/** Declared parcel weight (kg) — the shop does not track physical weights. */
export const SAMEDAY_PACKAGE_WEIGHT_KG = 1;
/** Response-body characters copied into an error — enough for Sameday's validation JSON. */
export const SAMEDAY_ERROR_BODY_MAX = 600;

/**
 * An error that names the HTTP status AND what Sameday answered: their 400s
 * carry the validation reason (which recipient field is blank, an unknown
 * county…), and that is what the operator needs to read on the order page.
 * The body is whitespace-collapsed and bounded, never echoed whole.
 */
export async function samedayFailure(what: string, response: Response): Promise<Error> {
	let body = '';
	try {
		body = (await response.text()).replace(/\s+/g, ' ').trim();
	} catch {
		// An unreadable body leaves the status as the only reason.
	}
	if (body.length > SAMEDAY_ERROR_BODY_MAX) body = `${body.slice(0, SAMEDAY_ERROR_BODY_MAX)}…`;
	return new Error(`${what} (HTTP ${response.status})${body ? `: ${body}` : ''}`);
}

export interface SamedayCourierOptions {
	username: string;
	password: string;
	/** Sameday pickup-point id for the warehouse parcels leave from. */
	pickupPoint: string;
	baseUrl?: string;
	serviceId?: number;
	timeoutMs?: number;
	/** Test seam: route HTTP through this fetch. Never set in app code. */
	fetchFn?: typeof fetch;
}

/**
 * Map Sameday's status vocabulary onto the normalized tracking states. Sameday
 * reports a numeric id plus Romanian text; the text is the stable part across
 * their API versions, so classification is by keyword. Unknown texts stay
 * `in-transit` once the parcel left (`registered` before pickup would mean the
 * cron stops seeing progress — in transit is the safe default for movement).
 */
export function normalizeSamedayStatus(statusText: string): CourierTrackingStatus {
	const text = statusText.toLowerCase();
	if (text.includes('livrat')) return 'delivered';
	if (text.includes('retur')) return 'returned';
	if (text.includes('anulat')) return 'cancelled';
	if (text.includes('emis') || text.includes('creat')) return 'registered';
	return 'in-transit';
}

/** Public tracking page Sameday offers per AWB. */
export function samedayTrackingUrl(awb: string): string {
	return `https://sameday.ro/#awb=${encodeURIComponent(awb)}`;
}

/**
 * The real Sameday-backed courier. Framework-free (credentials are passed in);
 * only ever constructed when COURIER_PROVIDER=sameday AND the credentials are
 * set — tests and dev default to the mock and never construct this. Every call
 * is bounded by an AbortSignal timeout: a hung courier socket must reject as a
 * handled error, never pin the request.
 *
 * NOTE: this adapter follows Sameday's public REST API (token auth via
 * /api/authenticate, AWB CRUD under /api/awb) but has not been exercised
 * against a live account from this codebase — doing that needs real courier
 * credentials and is a documented launch step (DEPLOYMENT.md §9).
 */
export function createSamedayCourier(options: SamedayCourierOptions): CourierProvider {
	const baseUrl = (options.baseUrl ?? SAMEDAY_BASE_URL_DEFAULT).replace(/\/$/, '');
	const serviceId = options.serviceId ?? SAMEDAY_SERVICE_ID_DEFAULT;
	const timeoutMs = options.timeoutMs ?? SAMEDAY_TIMEOUT_MS_DEFAULT;
	const fetchFn = options.fetchFn ?? fetch;

	let token: { value: string; expiresAt: number } | null = null;

	async function request(
		path: string,
		init: { method: string; headers?: Record<string, string>; body?: BodyInit }
	): Promise<Response> {
		const response = await fetchFn(`${baseUrl}${path}`, {
			...init,
			signal: AbortSignal.timeout(timeoutMs)
		});
		return response;
	}

	async function authToken(): Promise<string> {
		// Tokens last hours; refresh with a minute of slack.
		if (token && token.expiresAt - 60_000 > Date.now()) return token.value;
		const response = await request('/api/authenticate?remember_me=1', {
			method: 'POST',
			headers: { 'X-Auth-Username': options.username, 'X-Auth-Password': options.password }
		});
		if (!response.ok) {
			throw new Error(`Sameday authentication failed (HTTP ${response.status})`);
		}
		const data = (await response.json()) as { token?: string; expire_at_utc?: string };
		if (!data.token) throw new Error('Sameday authentication returned no token');
		const expiresAt = data.expire_at_utc ? Date.parse(data.expire_at_utc) : Date.now() + 3_600_000;
		token = { value: data.token, expiresAt: Number.isNaN(expiresAt) ? Date.now() : expiresAt };
		return token.value;
	}

	async function api(
		path: string,
		init: { method: string; body?: URLSearchParams }
	): Promise<Response> {
		return request(path, {
			method: init.method,
			headers: {
				'X-Auth-Token': await authToken(),
				...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
			},
			body: init.body
		});
	}

	return {
		name: 'sameday',

		async createShipment(shipment: ShipmentRequest) {
			const a = shipment.recipient.address;
			const body = new URLSearchParams({
				pickupPoint: options.pickupPoint,
				packageType: '0',
				packageNumber: '1',
				packageWeight: String(SAMEDAY_PACKAGE_WEIGHT_KG),
				service: String(serviceId),
				awbPayment: '1',
				cashOnDelivery: '0',
				insuredValue: '0',
				thirdPartyPickup: '0',
				clientInternalReference: shipment.reference,
				'parcels[0][weight]': String(SAMEDAY_PACKAGE_WEIGHT_KG),
				'awbRecipient[name]': shipment.recipient.name,
				'awbRecipient[personType]': '0',
				'awbRecipient[phoneNumber]': shipment.recipient.phone ?? '',
				'awbRecipient[email]': shipment.recipient.email,
				// The county is the address `state` and nothing else: a city name
				// in its place is a mis-routed parcel, not a fallback (FIX-11).
				'awbRecipient[countyString]': a.state ?? '',
				'awbRecipient[cityString]': a.city ?? '',
				'awbRecipient[address]': [a.line1, a.line2].filter(Boolean).join(', '),
				'awbRecipient[postalCode]': a.postalCode ?? ''
			});
			const response = await api('/api/awb', { method: 'POST', body });
			if (!response.ok) throw await samedayFailure('Sameday AWB creation failed', response);
			const data = (await response.json()) as { awbNumber?: string };
			if (!data.awbNumber) throw new Error('Sameday AWB creation returned no awbNumber');
			return { awb: data.awbNumber, trackingUrl: samedayTrackingUrl(data.awbNumber) };
		},

		async getLabel(awb) {
			const response = await api(`/api/awb/download/${encodeURIComponent(awb)}/A6`, {
				method: 'GET'
			});
			if (response.status === 404) return null;
			if (!response.ok) throw await samedayFailure('Sameday label download failed', response);
			return new Uint8Array(await response.arrayBuffer());
		},

		async trackShipment(awb) {
			const response = await api(`/api/client/awb/${encodeURIComponent(awb)}/status`, {
				method: 'GET'
			});
			if (response.status === 404) return null;
			if (!response.ok) throw await samedayFailure('Sameday status lookup failed', response);
			const data = (await response.json()) as {
				expeditionStatus?: { status?: string; statusState?: string };
			};
			const text = data.expeditionStatus?.statusState ?? data.expeditionStatus?.status ?? '';
			return text ? normalizeSamedayStatus(text) : null;
		},

		async cancelShipment(awb) {
			const response = await api(`/api/awb/${encodeURIComponent(awb)}`, { method: 'DELETE' });
			if (!response.ok) throw await samedayFailure('Sameday AWB cancellation failed', response);
		}
	};
}
