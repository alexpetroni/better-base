// Server barrel: schema, services, the queue drain, and env-bound deps.
import { env as publicEnv } from '$env/dynamic/public';
import { getDb } from '$lib/db';
import { getEmailSender } from '$lib/modules/email/server';
import { getSite } from '$lib/server/site';
import type { NurtureDrainDeps } from './drain.ts';

export * from './index.ts';
export {
	nurtureEnrollments,
	nurtureSends,
	nurtureSequences,
	type NurtureEnrollmentRow,
	type NurtureSendRow,
	type NurtureSequenceRow
} from './schema.ts';
export {
	NURTURE_RETENTION_DAYS,
	cancelSubscriberNurture,
	enrollFromOrderEmail,
	enrollFromQuizResult,
	enrollOnConsentConfirmed,
	isMailable,
	listParkedSends,
	listSequencesWithStats,
	pruneNurtureEnrollments,
	seedNurtureSequences,
	setSequenceActive,
	type NurtureDeps,
	type ParkedSend,
	type SequenceStats
} from './service.ts';
export { drainNurtureSends, type NurtureDrainDeps, type NurtureDrainResult } from './drain.ts';

/** Drain deps for the running app (the cron route). Tests build these explicitly. */
export function getNurtureDrainDeps(): NurtureDrainDeps {
	if (!publicEnv.PUBLIC_SITE_URL) throw new Error('PUBLIC_SITE_URL is not set');
	return {
		db: getDb(),
		email: getEmailSender(),
		siteName: getSite().name,
		baseUrl: publicEnv.PUBLIC_SITE_URL.replace(/\/$/, '')
	};
}
