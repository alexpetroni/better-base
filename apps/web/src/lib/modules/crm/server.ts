// Server module barrel: subscriber schema, services and token signing.
import { env } from '$env/dynamic/private';
import { tokenSecretFrom } from '$lib/server/secrets';

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

/** HMAC secret for signed action tokens — the dedicated TOKEN_SECRET, never the auth secret. */
export function getTokenSecret(): string {
	return tokenSecretFrom(env);
}
