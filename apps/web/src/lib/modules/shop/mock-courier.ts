import type {
	CourierProvider,
	CourierTrackingStatus,
	CreatedShipment,
	ShipmentRequest
} from './courier.ts';

/**
 * Deterministic in-memory courier: the dev/test default (selected whenever
 * COURIER_PROVIDER is unset or `mock`). AWBs are sequential, shipments live in
 * a map so the admin action, the label route and the cron sync all see what
 * was created — within one process, which is exactly the preview-server/e2e
 * situation. Tracking never advances on its own: tests drive it through
 * `setTrackingStatus`, so a sync run without an intervening change is a
 * provable no-op.
 */

export const MOCK_TRACKING_URL_BASE = 'https://tracking.courier.example/awb';

export interface MockCourierProvider extends CourierProvider {
	/** Test hooks: everything the mock has recorded so far. */
	readonly shipments: Map<string, { request: ShipmentRequest; status: CourierTrackingStatus }>;
	readonly cancelled: string[];
	setTrackingStatus(awb: string, status: CourierTrackingStatus): void;
	/** When set, the next createShipment call rejects with this error. */
	failNextCreate: Error | null;
}

/**
 * A minimal but structurally valid single-page PDF with the AWB as its text —
 * enough for a download to open in a viewer, byte-deterministic per AWB.
 */
export function mockLabelPdf(awb: string): Uint8Array {
	const stream = `BT /F1 12 Tf 40 800 Td (AWB ${awb}) Tj ET`;
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R ' +
			'/Resources << /Font << /F1 5 0 R >> >> >>',
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
	];
	let body = '%PDF-1.4\n';
	const offsets: number[] = [];
	objects.forEach((object, i) => {
		offsets.push(body.length);
		body += `${i + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xrefStart = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
	return new TextEncoder().encode(body);
}

export function createMockCourierProvider(): MockCourierProvider {
	let seq = 0;
	const shipments = new Map<string, { request: ShipmentRequest; status: CourierTrackingStatus }>();
	const cancelled: string[] = [];

	return {
		name: 'mock',
		shipments,
		cancelled,
		failNextCreate: null,

		setTrackingStatus(awb, status) {
			const shipment = shipments.get(awb);
			if (!shipment) throw new Error(`Mock courier: no shipment ${awb}`);
			shipment.status = status;
		},

		async createShipment(request): Promise<CreatedShipment> {
			if (this.failNextCreate) {
				const err = this.failNextCreate;
				this.failNextCreate = null;
				throw err;
			}
			const awb = `MOCKAWB${String(++seq).padStart(6, '0')}`;
			shipments.set(awb, { request, status: 'registered' });
			return { awb, trackingUrl: `${MOCK_TRACKING_URL_BASE}/${awb}` };
		},

		async getLabel(awb) {
			return shipments.has(awb) ? mockLabelPdf(awb) : null;
		},

		async trackShipment(awb) {
			return shipments.get(awb)?.status ?? null;
		},

		async cancelShipment(awb) {
			const shipment = shipments.get(awb);
			if (!shipment) throw new Error(`Mock courier: no shipment ${awb}`);
			if (shipment.status !== 'registered') {
				throw new Error(`Mock courier: ${awb} already picked up — cannot cancel`);
			}
			shipment.status = 'cancelled';
			cancelled.push(awb);
		}
	};
}
