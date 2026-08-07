import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { normalizeEmail } from '../../util/email.ts';
// Cross-module: schema.ts relative imports and `import type` are the allowed
// forms (the crm/quiz BARRELS pull .svelte files, which the plain-node seed
// script cannot load).
import type { ConsentKey } from '../crm/consent.ts';
import { subscribers, type SubscriberRow } from '../crm/schema.ts';
import { quizResults, quizzes } from '../quiz/schema.ts';
import { validateSequenceDefinition, type NurtureSequenceDefinition } from './definition.ts';
import { computeStepScheduledAt } from './schedule.ts';
import {
	nurtureEnrollments,
	nurtureSends,
	nurtureSequences,
	type NurtureSendRow,
	type NurtureSequenceRow
} from './schema.ts';

/** Framework-free ({ db } passed in), like the crm services. */
export interface NurtureDeps {
	db: Db;
}

/**
 * THE consent gate (GDPR-critical): the sequence's marketing consent is
 * granted AND the address is double-opt-in confirmed. Every enrollment path
 * runs through it, and the drain re-checks it right before each send.
 */
export function isMailable(
	subscriber: Pick<SubscriberRow, 'consents' | 'confirmedAt'>,
	consentKey: ConsentKey
): boolean {
	// Same rule as crm's hasConsent (inlined: the crm barrel is not
	// node-loadable and runtime imports of its internals are lint-banned).
	return subscriber.consents[consentKey]?.granted === true && subscriber.confirmedAt !== null;
}

async function activeSequences(db: Db): Promise<NurtureSequenceRow[]> {
	return db.select().from(nurtureSequences).where(eq(nurtureSequences.active, true));
}

/**
 * Enroll one subscriber in one sequence: the enrollment row plus every step's
 * send row (scheduled from the enrollment instant), atomically. Returns false
 * without writing when the consent gate fails or the subscriber was ever
 * enrolled before (unique index — the re-enrollment rule).
 */
async function enrollInSequence(
	db: Db,
	sequence: NurtureSequenceRow,
	subscriber: SubscriberRow,
	now: Date
): Promise<boolean> {
	if (!sequence.active) return false;
	if (!isMailable(subscriber, sequence.consentKey as ConsentKey)) return false;
	return db.transaction(async (tx) => {
		const [enrollment] = await tx
			.insert(nurtureEnrollments)
			.values({
				id: crypto.randomUUID(),
				sequenceId: sequence.id,
				subscriberId: subscriber.id,
				enrolledAt: now
			})
			.onConflictDoNothing({
				target: [nurtureEnrollments.sequenceId, nurtureEnrollments.subscriberId]
			})
			.returning();
		if (!enrollment) return false;
		await tx.insert(nurtureSends).values(
			sequence.steps.map((step, stepIndex) => ({
				id: crypto.randomUUID(),
				enrollmentId: enrollment.id,
				stepIndex,
				scheduledAt: computeStepScheduledAt(now, step)
			}))
		);
		return true;
	});
}

function quizTriggerMatches(
	sequence: NurtureSequenceRow,
	quizSlug: string,
	bandKey: string
): boolean {
	const trigger = sequence.trigger;
	if (trigger.kind !== 'quiz-completed' || trigger.quizSlug !== quizSlug) return false;
	return trigger.bands === undefined || trigger.bands.includes(bandKey);
}

/** Quiz results already linked to the subscriber, as (slug, band) facts. */
async function linkedQuizFacts(db: Db, subscriberId: string) {
	const rows = await db
		.select({ slug: quizzes.slug, profile: quizResults.profile })
		.from(quizResults)
		.innerJoin(quizzes, eq(quizResults.quizId, quizzes.id))
		.where(eq(quizResults.subscriberId, subscriberId));
	return rows.map((row) => ({ slug: row.slug, bandKey: row.profile.band.key }));
}

/**
 * Double opt-in just confirmed: enroll into `consent-confirmed` sequences,
 * and back-fill `quiz-completed` sequences for results the subscriber linked
 * BEFORE confirming (the quiz → signup → confirm path would otherwise never
 * enroll — at claim time the consent gate correctly refused). Idempotent.
 */
export async function enrollOnConsentConfirmed(
	deps: NurtureDeps,
	subscriberId: string,
	now = new Date()
): Promise<number> {
	const [subscriber] = await deps.db
		.select()
		.from(subscribers)
		.where(eq(subscribers.id, subscriberId));
	if (!subscriber) return 0;
	const sequences = await activeSequences(deps.db);
	if (sequences.length === 0) return 0;
	let enrolled = 0;
	for (const sequence of sequences.filter((s) => s.trigger.kind === 'consent-confirmed')) {
		if (await enrollInSequence(deps.db, sequence, subscriber, now)) enrolled += 1;
	}
	const quizSequences = sequences.filter((s) => s.trigger.kind === 'quiz-completed');
	if (quizSequences.length > 0) {
		const facts = await linkedQuizFacts(deps.db, subscriber.id);
		for (const sequence of quizSequences) {
			if (!facts.some((f) => quizTriggerMatches(sequence, f.slug, f.bandKey))) continue;
			if (await enrollInSequence(deps.db, sequence, subscriber, now)) enrolled += 1;
		}
	}
	return enrolled;
}

/**
 * A quiz result was claimed with an email: enroll the linked subscriber into
 * matching `quiz-completed` sequences (band-filtered). No-op unless the
 * subscriber is already mailable — the unconfirmed case is picked up by
 * `enrollOnConsentConfirmed` when the confirm link is clicked.
 */
export async function enrollFromQuizResult(
	deps: NurtureDeps,
	resultId: string,
	now = new Date()
): Promise<number> {
	const [found] = await deps.db
		.select({
			slug: quizzes.slug,
			profile: quizResults.profile,
			subscriberId: quizResults.subscriberId
		})
		.from(quizResults)
		.innerJoin(quizzes, eq(quizResults.quizId, quizzes.id))
		.where(eq(quizResults.id, resultId));
	if (!found?.subscriberId) return 0;
	const [subscriber] = await deps.db
		.select()
		.from(subscribers)
		.where(eq(subscribers.id, found.subscriberId));
	if (!subscriber) return 0;
	let enrolled = 0;
	for (const sequence of await activeSequences(deps.db)) {
		if (!quizTriggerMatches(sequence, found.slug, found.profile.band.key)) continue;
		if (await enrollInSequence(deps.db, sequence, subscriber, now)) enrolled += 1;
	}
	return enrolled;
}

/**
 * A paid order landed for this email: enroll into `order-paid` sequences.
 * "First order only" needs no counting — the unique enrollment makes every
 * later order a no-op.
 */
export async function enrollFromOrderEmail(
	deps: NurtureDeps,
	email: string,
	now = new Date()
): Promise<number> {
	const normalized = normalizeEmail(email);
	if (!normalized) return 0;
	const [subscriber] = await deps.db
		.select()
		.from(subscribers)
		.where(eq(subscribers.email, normalized));
	if (!subscriber) return 0;
	let enrolled = 0;
	for (const sequence of await activeSequences(deps.db)) {
		if (sequence.trigger.kind !== 'order-paid') continue;
		if (await enrollInSequence(deps.db, sequence, subscriber, now)) enrolled += 1;
	}
	return enrolled;
}

/**
 * Consent withdrawal / unsubscribe: cancel every pending send and every
 * active enrollment for the subscriber, across sequences, immediately.
 * (`sending` rows are mid-claim — the drain re-checks the consent gate before
 * the actual send and cancels there.)
 */
export async function cancelSubscriberNurture(
	deps: NurtureDeps,
	subscriberId: string,
	now = new Date()
): Promise<{ enrollments: number; sends: number }> {
	return deps.db.transaction(async (tx) => {
		const enrollmentIds = (
			await tx
				.select({ id: nurtureEnrollments.id })
				.from(nurtureEnrollments)
				.where(
					and(
						eq(nurtureEnrollments.subscriberId, subscriberId),
						eq(nurtureEnrollments.status, 'active')
					)
				)
		).map((row) => row.id);
		if (enrollmentIds.length === 0) return { enrollments: 0, sends: 0 };
		const sends = await tx
			.update(nurtureSends)
			.set({ status: 'cancelled' })
			.where(
				and(inArray(nurtureSends.enrollmentId, enrollmentIds), eq(nurtureSends.status, 'pending'))
			)
			.returning({ id: nurtureSends.id });
		await tx
			.update(nurtureEnrollments)
			.set({ status: 'cancelled', closedAt: now })
			.where(inArray(nurtureEnrollments.id, enrollmentIds));
		return { enrollments: enrollmentIds.length, sends: sends.length };
	});
}

/** Cancel ONE enrollment (drain-side, when its consent gate fails at send time). */
export async function cancelEnrollment(db: Db, enrollmentId: string, now: Date): Promise<void> {
	await db
		.update(nurtureSends)
		.set({ status: 'cancelled' })
		.where(and(eq(nurtureSends.enrollmentId, enrollmentId), eq(nurtureSends.status, 'pending')));
	await db
		.update(nurtureEnrollments)
		.set({ status: 'cancelled', closedAt: now })
		.where(and(eq(nurtureEnrollments.id, enrollmentId), eq(nurtureEnrollments.status, 'active')));
}

/**
 * Seed/refresh sequences from the site config: upsert by `key`, updating
 * name/trigger/steps/consent so copy edits deploy — but NEVER `active`: the
 * operator's kill switch in /admin/nurture survives a reseed.
 */
export async function seedNurtureSequences(
	db: Db,
	definitions: NurtureSequenceDefinition[],
	now = new Date()
): Promise<number> {
	const problems = definitions.flatMap(validateSequenceDefinition);
	if (problems.length > 0) {
		throw new Error(`Invalid nurture sequence definition(s):\n- ${problems.join('\n- ')}`);
	}
	for (const def of definitions) {
		await db
			.insert(nurtureSequences)
			.values({
				id: crypto.randomUUID(),
				key: def.key,
				name: def.name,
				trigger: def.trigger,
				consentKey: def.consentKey,
				steps: def.steps
			})
			.onConflictDoUpdate({
				target: nurtureSequences.key,
				set: {
					name: def.name,
					trigger: def.trigger,
					consentKey: def.consentKey,
					steps: def.steps,
					updatedAt: now
				}
			});
	}
	return definitions.length;
}

/** Admin list: every sequence with enrollment and send counts. */
export interface SequenceStats {
	sequence: NurtureSequenceRow;
	enrolled: number;
	activeEnrollments: number;
	pendingSends: number;
	sentSends: number;
	failedSends: number;
}

export async function listSequencesWithStats(deps: NurtureDeps): Promise<SequenceStats[]> {
	const sequences = await deps.db
		.select()
		.from(nurtureSequences)
		.orderBy(asc(nurtureSequences.name), asc(nurtureSequences.key));
	const enrollmentCounts = await deps.db
		.select({
			sequenceId: nurtureEnrollments.sequenceId,
			status: nurtureEnrollments.status,
			count: sql<number>`cast(count(*) as int)`
		})
		.from(nurtureEnrollments)
		.groupBy(nurtureEnrollments.sequenceId, nurtureEnrollments.status);
	const sendCounts = await deps.db
		.select({
			sequenceId: nurtureEnrollments.sequenceId,
			status: nurtureSends.status,
			count: sql<number>`cast(count(*) as int)`
		})
		.from(nurtureSends)
		.innerJoin(nurtureEnrollments, eq(nurtureSends.enrollmentId, nurtureEnrollments.id))
		.groupBy(nurtureEnrollments.sequenceId, nurtureSends.status);
	return sequences.map((sequence) => {
		const enrollments = enrollmentCounts.filter((c) => c.sequenceId === sequence.id);
		const sends = sendCounts.filter((c) => c.sequenceId === sequence.id);
		const sendCount = (statuses: NurtureSendRow['status'][]) =>
			sends.filter((c) => statuses.includes(c.status)).reduce((sum, c) => sum + c.count, 0);
		return {
			sequence,
			enrolled: enrollments.reduce((sum, c) => sum + c.count, 0),
			activeEnrollments: enrollments
				.filter((c) => c.status === 'active')
				.reduce((s, c) => s + c.count, 0),
			pendingSends: sendCount(['pending', 'sending']),
			sentSends: sendCount(['sent']),
			failedSends: sendCount(['failed'])
		};
	});
}

/** The operator kill switch behind /admin/nurture. */
export async function setSequenceActive(
	deps: NurtureDeps,
	sequenceId: string,
	active: boolean,
	now = new Date()
): Promise<boolean> {
	const updated = await deps.db
		.update(nurtureSequences)
		.set({ active, updatedAt: now })
		.where(eq(nurtureSequences.id, sequenceId))
		.returning({ id: nurtureSequences.id });
	return updated.length > 0;
}

/** Parked (failed) sends for operator attention, newest first. */
export interface ParkedSend {
	sendId: string;
	sequenceName: string;
	stepIndex: number;
	email: string;
	attempts: number;
	lastError: string | null;
	scheduledAt: Date;
}

export async function listParkedSends(deps: NurtureDeps, limit = 50): Promise<ParkedSend[]> {
	const rows = await deps.db
		.select({
			sendId: nurtureSends.id,
			sequenceName: nurtureSequences.name,
			stepIndex: nurtureSends.stepIndex,
			email: subscribers.email,
			attempts: nurtureSends.attempts,
			lastError: nurtureSends.lastError,
			scheduledAt: nurtureSends.scheduledAt
		})
		.from(nurtureSends)
		.innerJoin(nurtureEnrollments, eq(nurtureSends.enrollmentId, nurtureEnrollments.id))
		.innerJoin(nurtureSequences, eq(nurtureEnrollments.sequenceId, nurtureSequences.id))
		.innerJoin(subscribers, eq(nurtureEnrollments.subscriberId, subscribers.id))
		.where(eq(nurtureSends.status, 'failed'))
		.orderBy(desc(nurtureSends.scheduledAt))
		.limit(limit);
	return rows;
}

/** Closed enrollments (and their sends, via cascade) expire after this. */
export const NURTURE_RETENTION_DAYS = 180;

/** Retention sweep hook: delete closed enrollments past the cutoff. */
export async function pruneNurtureEnrollments(db: Db, cutoff: Date): Promise<number> {
	const deleted = await db
		.delete(nurtureEnrollments)
		.where(
			and(
				inArray(nurtureEnrollments.status, ['completed', 'cancelled']),
				lt(nurtureEnrollments.closedAt, cutoff)
			)
		)
		.returning({ id: nurtureEnrollments.id });
	return deleted.length;
}
