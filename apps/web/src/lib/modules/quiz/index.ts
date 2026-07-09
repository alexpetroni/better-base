// Universal barrel: the pure scoring engine, validation and types — usable
// from client code (admin editor preview) and unit tests. Db-bound services
// live in ./server.
export type { QuizResultRow, QuizRow, QuizStatus, StoredAnswer } from './schema.ts';
export {
	answersFromSubmitAnswers,
	flattenStepResponses,
	pickBand,
	scoreQuiz,
	validateScoringConfig,
	type DimensionScore,
	type QuestionScoring,
	type QuizAnswers,
	type QuizProfile,
	type ScoringBand,
	type ScoringConfig
} from './scoring.ts';
export { countQuestions, validateForPublish, validateFormSchema } from './validate.ts';
