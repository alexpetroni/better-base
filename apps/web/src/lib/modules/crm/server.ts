// Server module barrel: subscriber schema, services and token signing.
import { env } from '$env/dynamic/private';
import { tokenSecretFrom } from '$lib/server/secrets';

export { subscribers, type SubscriberRow } from './schema.ts';
export {
	confirmSubscriber,
	getSubscriber,
	listSubscribers,
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
