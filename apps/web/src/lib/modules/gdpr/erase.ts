import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { subscribers } from '../crm/schema.ts';
import { normalizeEmail } from '../crm/service.ts';
import { emailLog } from '../email/schema.ts';
import { quizResults } from '../quiz/schema.ts';
import { orders } from '../shop/schema.ts';

/**
 * GDPR right-to-erasure for a subscriber/customer email. Node-safe (used by
 * the `pnpm subscriber:delete` CLI):
 *
 * - the subscriber row is DELETED (consents, tokens, confirmation gone);
 * - their quiz results are unlinked first (kept as anonymous statistics —
 *   answers contain no contact data);
 * - orders are kept for legal/accounting retention but the email and the
 *   shipping address (name, street) are anonymized;
 * - the email log keeps its idempotency keys but recipient + payload are
 *   anonymized.
 */

export const ANONYMIZED_EMAIL = 'anonimizat@gdpr.invalid';

export interface EraseSummary {
	subscriberDeleted: boolean;
	quizResultsUnlinked: number;
	ordersAnonymized: number;
	emailLogAnonymized: number;
}

export type EraseResult = { ok: true; value: EraseSummary } | { ok: false; error: 'invalid-email' };

export async function eraseSubscriberData(
	deps: { db: Db },
	rawEmail: string
): Promise<EraseResult> {
	const email = normalizeEmail(rawEmail);
	if (!email) return { ok: false, error: 'invalid-email' };
	const { db } = deps;

	let subscriberDeleted = false;
	let quizResultsUnlinked = 0;
	const [subscriber] = await db.select().from(subscribers).where(eq(subscribers.email, email));
	if (subscriber) {
		const unlinked = await db
			.update(quizResults)
			.set({ subscriberId: null })
			.where(eq(quizResults.subscriberId, subscriber.id))
			.returning({ id: quizResults.id });
		quizResultsUnlinked = unlinked.length;
		await db.delete(subscribers).where(eq(subscribers.id, subscriber.id));
		subscriberDeleted = true;
	}

	const anonymizedOrders = await db
		.update(orders)
		.set({ email: ANONYMIZED_EMAIL, shippingAddress: null })
		.where(eq(orders.email, email))
		.returning({ id: orders.id });

	const anonymizedLog = await db
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
			emailLogAnonymized: anonymizedLog.length
		}
	};
}
