import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import type { FormConfig } from 'formcomp';
import { pillars } from '../../db/schema/core.ts';
import { users } from '../auth/schema.ts';
import { subscribers } from '../crm/schema.ts';
import type { QuizProfile, ScoringConfig } from './scoring.ts';

/**
 * Quizzes: the formcomp schema AND the scoring config are content (jsonb),
 * edited in the admin as validated JSON. Visibility on a site follows the
 * pillar tag, like articles — no site column anywhere.
 */
export const quizzes = pgTable(
	'quizzes',
	{
		id: text('id').primaryKey(),
		slug: text('slug').notNull().unique(),
		title: text('title').notNull(),
		introMd: text('intro_md').notNull().default(''),
		pillarId: integer('pillar_id').references(() => pillars.id, { onDelete: 'set null' }),
		formSchema: jsonb('form_schema').notNull().$type<FormConfig>().default({ steps: [] }),
		scoring: jsonb('scoring')
			.notNull()
			.$type<ScoringConfig>()
			.default({ questions: {}, bands: [] }),
		status: text('status', { enum: ['draft', 'published'] })
			.notNull()
			.default('draft'),
		resultTemplateKey: text('result_template_key').notNull().default('quiz-result'),
		createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('quizzes_pillar_id_idx').on(table.pillarId),
		index('quizzes_created_by_idx').on(table.createdBy)
	]
);

/** One stored answer, straight from formcomp's submit payload (keyed by stable uuid). */
export interface StoredAnswer {
	uuid: string;
	questionId: string;
	stepId: string;
	type: string;
	label: string;
	value: unknown;
	displayValue: string;
}

export const quizResults = pgTable(
	'quiz_results',
	{
		id: text('id').primaryKey(),
		quizId: text('quiz_id')
			.notNull()
			.references(() => quizzes.id, { onDelete: 'cascade' }),
		subscriberId: text('subscriber_id').references(() => subscribers.id, {
			onDelete: 'set null'
		}),
		answers: jsonb('answers').notNull().$type<StoredAnswer[]>().default([]),
		score: integer('score').notNull(),
		profile: jsonb('profile').notNull().$type<QuizProfile>(),
		/**
		 * Idempotency key for the public submit endpoint: per-attempt client
		 * token + answers digest (see `submitQuiz`). Null for writers that have
		 * no retry problem (nulls never collide in the unique index).
		 */
		clientToken: text('client_token'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(table) => [
		index('quiz_results_quiz_id_created_at_idx').on(table.quizId, table.createdAt),
		index('quiz_results_subscriber_id_idx').on(table.subscriberId),
		uniqueIndex('quiz_results_quiz_id_client_token_uq').on(table.quizId, table.clientToken)
	]
);

export type QuizRow = typeof quizzes.$inferSelect;
export type QuizStatus = QuizRow['status'];
export type QuizResultRow = typeof quizResults.$inferSelect;
