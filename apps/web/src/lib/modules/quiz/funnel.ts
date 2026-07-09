import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import {
	sendNewsletterConfirmEmail,
	upsertSubscriber,
	type NewsletterSignupDeps
} from '../crm/service.ts';
import type { ConsentChanges } from '../crm/consent.ts';
import type { EmailSender, SendEmailOutcome } from '../email/service.ts';
import { quizResults } from './schema.ts';
import { getResultWithQuiz } from './service.ts';

/**
 * The email step after a quiz: the visitor already SEES the result on-page;
 * giving an email is optional and only adds delivery + (optional) marketing
 * consents. The quiz-result email is transactional — it goes out for the
 * given address regardless of the consent checkboxes, exactly once per
 * (result, address) even when the handler retries.
 */

export interface QuizFunnelDeps {
	db: Db;
	email: EmailSender;
	/** HMAC secret for the newsletter confirm token. */
	secret: string;
	/** Public origin for links in emails. */
	baseUrl: string;
	siteName: string;
}

export interface ClaimQuizResultInput {
	resultId: string;
	email: string;
	name?: string;
	locale?: string;
	/** Explicit checkbox states — unticked (false) means "don't touch". */
	newsletter: boolean;
	profileEmails: boolean;
}

export type ClaimQuizResultOutcome =
	| {
			ok: true;
			subscriberId: string;
			resultEmail: SendEmailOutcome['status'];
			newsletterConfirm: SendEmailOutcome['status'] | 'already-confirmed' | 'not-requested';
	  }
	| { ok: false; error: 'not-found' | 'invalid-email' };

export async function claimQuizResult(
	deps: QuizFunnelDeps,
	input: ClaimQuizResultInput
): Promise<ClaimQuizResultOutcome> {
	const found = await getResultWithQuiz({ db: deps.db }, input.resultId);
	if (!found) return { ok: false, error: 'not-found' };
	const { result, quiz } = found;

	// GDPR: only ticked boxes become grants; an unticked box is a no-op.
	const grants: ConsentChanges = {};
	if (input.newsletter) grants.newsletter = true;
	if (input.profileEmails) grants.profile_emails = true;

	const upserted = await upsertSubscriber(deps, {
		email: input.email,
		name: input.name,
		locale: input.locale,
		grants,
		source: `quiz:${quiz.slug}`
	});
	if (!upserted.ok) return upserted;
	const subscriber = upserted.value;

	await deps.db
		.update(quizResults)
		.set({ subscriberId: subscriber.id })
		.where(eq(quizResults.id, result.id));

	const resultEmail = await deps.email.send({
		to: subscriber.email,
		template: 'quiz-result',
		data: {
			siteName: deps.siteName,
			quizTitle: quiz.title,
			score: result.profile.score,
			maxScore: result.profile.maxScore,
			bandLabel: result.profile.band.label,
			advice: result.profile.band.advice,
			resultUrl: `${deps.baseUrl}/quiz/${quiz.slug}/rezultat/${result.id}`
		},
		// Includes the address: a retry never re-sends, a corrected typo does.
		idempotencyKey: `quiz-result:${result.id}:${subscriber.email}`
	});

	const signupDeps: NewsletterSignupDeps = { ...deps, siteName: deps.siteName };
	const newsletterConfirm = input.newsletter
		? await sendNewsletterConfirmEmail(signupDeps, subscriber)
		: 'not-requested';

	return {
		ok: true,
		subscriberId: subscriber.id,
		resultEmail: resultEmail.status,
		newsletterConfirm
	};
}
