/**
 * The durable, no-account way back to an order: the success/lookup page keyed
 * by the unguessable Stripe session id. Emails (confirmation, invoice,
 * shipping notification) all link here. A leaf module so both webhook.ts and
 * shipment-service.ts can use it without importing each other.
 */
export function orderLookupUrl(publicBaseUrl: string, stripeSessionId: string): string {
	return `${publicBaseUrl.replace(/\/$/, '')}/cos/succes?session_id=${stripeSessionId}`;
}
