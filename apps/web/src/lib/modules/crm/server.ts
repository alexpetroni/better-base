// Server module barrel: subscriber schema, services and token signing.
import { env } from '$env/dynamic/private';

export { subscribers, type SubscriberRow } from './schema.ts';
export {
	CONFIRM_TOKEN_TTL_SECONDS,
	confirmSubscriber,
	getSubscriber,
	listSubscribers,
	NEWSLETTER_CONFIRM_PURPOSE,
	normalizeEmail,
	requestNewsletterSignup,
	sendNewsletterConfirmEmail,
	subscribersCsv,
	unsubscribeByToken,
	upsertSubscriber,
	type ConfirmOutcome,
	type CrmDeps,
	type CrmResult,
	type NewsletterSignupDeps,
	type NewsletterSignupInput,
	type NewsletterSignupOutcome,
	type UpsertSubscriberInput
} from './service.ts';
export { signToken, verifyToken, type TokenClaims, type TokenVerification } from './token.ts';

/** HMAC secret for signed action tokens (reuses the auth session secret). */
export function getTokenSecret(): string {
	if (!env.BETTER_AUTH_SECRET) throw new Error('BETTER_AUTH_SECRET is not set');
	return env.BETTER_AUTH_SECRET;
}
