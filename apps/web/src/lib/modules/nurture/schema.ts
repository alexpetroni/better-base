import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import { subscribers } from '../crm/schema.ts';
import type { SequenceStep, SequenceTrigger } from './definition.ts';

/**
 * Nurture sequences as data (rows, seeded from site config) plus the
 * database-backed send queue drained by /api/cron/nurture-send. See README.md
 * for the design decision (DB queue + cron over a worker/external scheduler).
 */

export const nurtureSequences = pgTable('nurture_sequences', {
	id: text('id').primaryKey(),
	/** Stable identifier from the site config; the seed upserts by it. */
	key: text('key').notNull().unique(),
	name: text('name').notNull(),
	trigger: jsonb('trigger').notNull().$type<SequenceTrigger>(),
	/** Which marketing consent gates enrollment and every send. */
	consentKey: text('consent_key').notNull().default('newsletter'),
	steps: jsonb('steps').notNull().$type<SequenceStep[]>().default([]),
	/** The operator's kill switch (/admin/nurture) — no deploy needed. */
	active: boolean('active').notNull().default(true),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export const nurtureEnrollments = pgTable(
	'nurture_enrollments',
	{
		id: text('id').primaryKey(),
		sequenceId: text('sequence_id')
			.notNull()
			.references(() => nurtureSequences.id, { onDelete: 'cascade' }),
		// Cascade: GDPR erasure of the subscriber removes enrollments and sends.
		subscriberId: text('subscriber_id')
			.notNull()
			.references(() => subscribers.id, { onDelete: 'cascade' }),
		status: text('status', { enum: ['active', 'completed', 'cancelled'] })
			.notNull()
			.default('active'),
		enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull().defaultNow(),
		/** Stamped on completed AND cancelled — the retention cutoff. */
		closedAt: timestamp('closed_at', { withTimezone: true })
	},
	(table) => [
		// THE re-enrollment rule: once per (sequence, subscriber), ever.
		uniqueIndex('nurture_enrollments_sequence_subscriber_uq').on(
			table.sequenceId,
			table.subscriberId
		),
		index('nurture_enrollments_subscriber_id_idx').on(table.subscriberId),
		index('nurture_enrollments_status_closed_at_idx').on(table.status, table.closedAt)
	]
);

export const nurtureSends = pgTable(
	'nurture_sends',
	{
		id: text('id').primaryKey(),
		enrollmentId: text('enrollment_id')
			.notNull()
			.references(() => nurtureEnrollments.id, { onDelete: 'cascade' }),
		stepIndex: integer('step_index').notNull(),
		scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
		status: text('status', { enum: ['pending', 'sending', 'sent', 'failed', 'cancelled'] })
			.notNull()
			.default('pending'),
		/** Incremented at claim time; NURTURE_MAX_ATTEMPTS parks the send. */
		attempts: integer('attempts').notNull().default(0),
		claimedAt: timestamp('claimed_at', { withTimezone: true }),
		sentAt: timestamp('sent_at', { withTimezone: true }),
		lastError: text('last_error'),
		/**
		 * Hash of the sequence's `steps` when this row was planned. A reseed
		 * that changes the steps re-plans pending rows whose hash no longer
		 * matches (service.ts `seedNurtureSequences`). NULL = planned before
		 * the column existed; such rows are left as they are.
		 */
		stepsHash: text('steps_hash')
	},
	(table) => [
		// The email idempotency key `nurture:<enrollmentId>:<stepIndex>` derives
		// from this uniqueness: one queue row, at most one delivery, ever.
		uniqueIndex('nurture_sends_enrollment_step_uq').on(table.enrollmentId, table.stepIndex),
		index('nurture_sends_status_scheduled_at_idx').on(table.status, table.scheduledAt)
	]
);

export type NurtureSequenceRow = typeof nurtureSequences.$inferSelect;
export type NurtureEnrollmentRow = typeof nurtureEnrollments.$inferSelect;
export type NurtureSendRow = typeof nurtureSends.$inferSelect;
