/**
 * The fulfillment state machine — pure data + predicates, safe for client
 * code (the admin UI renders the legal transitions from it). The ONLY writer
 * that applies a transition to the database is `transitionFulfillment` in
 * fulfillment-service.ts; a unit test asserts nothing else touches the column.
 */

export const FULFILLMENT_STATUSES = [
	'unfulfilled',
	'packed',
	'shipped',
	'delivered',
	'returned',
	'cancelled'
] as const;

export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

export function isFulfillmentStatus(value: unknown): value is FulfillmentStatus {
	return (FULFILLMENT_STATUSES as readonly unknown[]).includes(value);
}

/**
 * Legal moves per state. The happy path is unfulfilled → packed → shipped →
 * delivered. Deliberate edges beyond it:
 * - `packed → unfulfilled`: an unpack correction — a mis-click must not strand
 *   the order (shipping is the point of no return, so no such edge later);
 * - `cancelled` only BEFORE shipping — once goods left, the path is
 *   shipped/delivered → returned, never cancelled;
 * - `returned` from shipped (refused/undeliverable parcel) or delivered
 *   (customer return);
 * - `returned` and `cancelled` are terminal.
 */
const LEGAL_TRANSITIONS: Record<FulfillmentStatus, readonly FulfillmentStatus[]> = {
	unfulfilled: ['packed', 'cancelled'],
	packed: ['shipped', 'unfulfilled', 'cancelled'],
	shipped: ['delivered', 'returned'],
	delivered: ['returned'],
	returned: [],
	cancelled: []
};

/** The transitions an operator may take from `from`, in display order. */
export function legalTransitions(from: FulfillmentStatus): readonly FulfillmentStatus[] {
	return LEGAL_TRANSITIONS[from];
}

export function canTransition(from: FulfillmentStatus, to: FulfillmentStatus): boolean {
	return LEGAL_TRANSITIONS[from].includes(to);
}

/** Thrown (or carried in a Result) when a requested transition is not legal. */
export class IllegalTransitionError extends Error {
	readonly from: FulfillmentStatus;
	readonly to: FulfillmentStatus;

	constructor(from: FulfillmentStatus, to: FulfillmentStatus) {
		super(`illegal fulfillment transition: ${from} → ${to}`);
		this.name = 'IllegalTransitionError';
		this.from = from;
		this.to = to;
	}
}
