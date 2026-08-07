import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { normalizeEmail } from '../../util/email.ts';
import type { Result } from '../../util/result.ts';
import { subscribers } from '../crm/schema.ts';
import { emailLog } from '../email/schema.ts';
import { invoices } from '../invoice/schema.ts';
import { quizResults } from '../quiz/schema.ts';
import { orders } from '../shop/schema.ts';

/**
 * GDPR right-to-erasure for a subscriber/customer email. Node-safe (used by
 * the `pnpm subscriber:delete` CLI):
 *
 * - the subscriber row is DELETED (consents, tokens, confirmation gone);
 * - their quiz results are unlinked first (kept as anonymous statistics —
 *   answers contain no contact data);
 * - orders are kept for legal/accounting retention but the email, the
 *   shipping address (name, street) and the billing-company capture are
 *   anonymized;
 * - the email log keeps its idempotency keys but recipient + payload are
 *   anonymized;
 * - ISSUED INVOICES ARE LEFT INTACT, deliberately: they are accounting
 *   records under a legal retention obligation (Legea contabilității 82/1991
 *   art. 25 — see modules/invoice/README.md), which GDPR art. 17(3)(b)
 *   exempts from erasure. The DB forbids mutating them anyway (append-only
 *   triggers). Their count is reported so the operator can answer the data
 *   subject precisely about what was retained and why.
 */

export const ANONYMIZED_EMAIL = 'anonimizat@gdpr.invalid';

export interface EraseSummary {
	subscriberDeleted: boolean;
	quizResultsUnlinked: number;
	ordersAnonymized: number;
	emailLogAnonymized: number;
	/** Invoices kept under the accounting-retention obligation (never erased). */
	invoicesRetained: number;
}

export type EraseResult = Result<EraseSummary, 'invalid-email'>;

export async function eraseSubscriberData(
	deps: { db: Db },
	rawEmail: string
): Promise<EraseResult> {
	const email = normalizeEmail(rawEmail);
	if (!email) return { ok: false, error: 'invalid-email' };

	// One transaction: erasure is all-or-nothing, so a mid-way failure can't
	// leave a half-erased account behind a CLI that reported the error.
	return deps.db.transaction(async (tx): Promise<EraseResult> => {
		let subscriberDeleted = false;
		let quizResultsUnlinked = 0;
		const [subscriber] = await tx.select().from(subscribers).where(eq(subscribers.email, email));
		if (subscriber) {
			const unlinked = await tx
				.update(quizResults)
				.set({ subscriberId: null })
				.where(eq(quizResults.subscriberId, subscriber.id))
				.returning({ id: quizResults.id });
			quizResultsUnlinked = unlinked.length;
			await tx.delete(subscribers).where(eq(subscribers.id, subscriber.id));
			subscriberDeleted = true;
		}

		const anonymizedOrders = await tx
			.update(orders)
			.set({ email: ANONYMIZED_EMAIL, shippingAddress: null, billingCompany: null })
			.where(eq(orders.email, email))
			.returning({ id: orders.id });

		// Count (not touch) the fiscal documents that stay behind — legally
		// retained accounting records, exempt from erasure (see module doc).
		const retainedInvoices =
			anonymizedOrders.length === 0
				? []
				: await tx
						.select({ id: invoices.id })
						.from(invoices)
						.where(
							inArray(
								invoices.orderId,
								anonymizedOrders.map((o) => o.id)
							)
						);

		const anonymizedLog = await tx
			.update(emailLog)
			.set({ toEmail: ANONYMIZED_EMAIL, data: {}, updatedAt: new Date() })
			.where(eq(emailLog.toEmail, email))
			.returning({ id: emailLog.id });

		return {
			ok: true,
			value: {
				subscriberDeleted,
				quizResultsUnlinked,
				ordersAnonymized: anonymizedOrders.length,
				emailLogAnonymized: anonymizedLog.length,
				invoicesRetained: retainedInvoices.length
			}
		};
	});
}
