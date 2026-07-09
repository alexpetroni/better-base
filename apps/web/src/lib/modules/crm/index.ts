// Universal barrel: the signup component, consent shaping and types. Db,
// tokens and services live in ./server.
export { default as NewsletterSignup } from './NewsletterSignup.svelte';
export {
	applyConsents,
	hasConsent,
	revokeAllConsents,
	type ConsentChanges,
	type ConsentKey,
	type ConsentRecord,
	type Consents
} from './consent.ts';
