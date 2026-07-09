import type { FormConfig, Question } from 'formcomp';
import { isRecord } from '../../util/object.ts';

/**
 * Pure scoring engine: (form schema, scoring config, answers) → profile.
 * No db, no framework — fully unit-testable. The scoring config is authored
 * as JSON in the admin editor and validated with `validateScoringConfig`.
 */

export interface ScoringBand {
	key: string;
	/** The band applies from this score upward (inclusive), until the next band's min. */
	min: number;
	label: string;
	advice: string;
}

export type QuestionScoring =
	| {
			kind: 'map';
			/** Answer value → points. Multi-select answers sum the points of every selected value. */
			map: Record<string, number>;
			dimension?: string;
	  }
	| {
			kind: 'numeric';
			/** Points = numeric answer (clamped to the question's min/max) × multiplier, then capped. */
			multiplier?: number;
			cap?: number;
			dimension?: string;
	  };

export interface ScoringConfig {
	questions: Record<string, QuestionScoring>;
	/** Dimension key → ro label. Questions opt in via their `dimension` field. */
	dimensions?: Record<string, { label: string }>;
	/** Sorted ascending by `min`; the total score picks the highest band it reaches. */
	bands: ScoringBand[];
}

export interface DimensionScore {
	key: string;
	label: string;
	score: number;
	maxScore: number | null;
}

export interface QuizProfile {
	score: number;
	/** Highest reachable score, or null when a numeric question is unbounded. */
	maxScore: number | null;
	band: ScoringBand;
	dimensions: DimensionScore[];
}

/** Flat answers keyed by question id — what the engine consumes. */
export type QuizAnswers = Record<string, unknown>;

/** Flatten formcomp's `onFormComplete` shape (responses keyed by step, then question). */
export function flattenStepResponses(byStep: Record<string, Record<string, unknown>>): QuizAnswers {
	const flat: QuizAnswers = {};
	for (const stepResponses of Object.values(byStep)) Object.assign(flat, stepResponses);
	return flat;
}

/** Flatten a formcomp submit payload's answers array. */
export function answersFromSubmitAnswers(
	answers: Array<{ questionId: string; value: unknown }>
): QuizAnswers {
	const flat: QuizAnswers = {};
	for (const answer of answers) flat[answer.questionId] = answer.value;
	return flat;
}

export function pickBand(bands: ScoringBand[], score: number): ScoringBand {
	if (bands.length === 0) throw new Error('Scoring config has no bands');
	const sorted = [...bands].sort((a, b) => a.min - b.min);
	let picked = sorted[0];
	for (const band of sorted) if (score >= band.min) picked = band;
	return picked;
}

function questionsById(form: FormConfig): Map<string, Question> {
	const byId = new Map<string, Question>();
	for (const step of form.steps) {
		for (const group of step.groups) {
			for (const question of group.questions) byId.set(question.id, question);
		}
	}
	return byId;
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
	if (min !== undefined && value < min) return min;
	if (max !== undefined && value > max) return max;
	return value;
}

function mapPoints(map: Record<string, number>, answer: unknown): number {
	if (answer === undefined || answer === null) return 0;
	if (Array.isArray(answer)) {
		return answer.reduce<number>((sum, value) => sum + (map[String(value)] ?? 0), 0);
	}
	return map[String(answer)] ?? 0;
}

function numericPoints(
	spec: Extract<QuestionScoring, { kind: 'numeric' }>,
	question: Question | undefined,
	answer: unknown
): number {
	const value = typeof answer === 'number' ? answer : Number(answer);
	if (answer === undefined || answer === null || answer === '' || Number.isNaN(value)) return 0;
	let points = clamp(value, question?.min, question?.max) * (spec.multiplier ?? 1);
	if (spec.cap !== undefined) points = Math.min(points, spec.cap);
	return points;
}

/** Highest reachable points for one scored question, or null when unbounded. */
function questionMax(spec: QuestionScoring, question: Question | undefined): number | null {
	if (spec.kind === 'map') {
		const values = Object.values(spec.map);
		if (values.length === 0) return 0;
		if (question?.type === 'multi-select') {
			return values.filter((v) => v > 0).reduce((a, b) => a + b, 0);
		}
		return Math.max(0, ...values);
	}
	const multiplier = spec.multiplier ?? 1;
	const fromQuestion = question?.max !== undefined ? question.max * multiplier : null;
	if (spec.cap !== undefined) {
		return fromQuestion === null ? spec.cap : Math.min(fromQuestion, spec.cap);
	}
	return fromQuestion;
}

export function scoreQuiz(
	form: FormConfig,
	scoring: ScoringConfig,
	answers: QuizAnswers
): QuizProfile {
	const byId = questionsById(form);

	let score = 0;
	let maxScore: number | null = 0;
	const perDimension = new Map<string, { score: number; maxScore: number | null }>();
	for (const key of Object.keys(scoring.dimensions ?? {})) {
		perDimension.set(key, { score: 0, maxScore: 0 });
	}

	for (const [questionId, spec] of Object.entries(scoring.questions)) {
		const question = byId.get(questionId);
		const points =
			spec.kind === 'map'
				? mapPoints(spec.map, answers[questionId])
				: numericPoints(spec, question, answers[questionId]);
		const max = questionMax(spec, question);

		score += points;
		maxScore = maxScore === null || max === null ? null : maxScore + max;

		const dimension = spec.dimension ? perDimension.get(spec.dimension) : undefined;
		if (dimension) {
			dimension.score += points;
			dimension.maxScore =
				dimension.maxScore === null || max === null ? null : dimension.maxScore + max;
		}
	}

	const dimensions: DimensionScore[] = Object.entries(scoring.dimensions ?? {}).map(
		([key, { label }]) => ({
			key,
			label,
			score: perDimension.get(key)?.score ?? 0,
			maxScore: perDimension.get(key)?.maxScore ?? 0
		})
	);

	return { score, maxScore, band: pickBand(scoring.bands, score), dimensions };
}

const OPTION_TYPES = new Set(['single-select', 'multi-select', 'select', 'likert']);

/**
 * Validate a scoring config (as parsed, untrusted JSON) against a form
 * schema. Returns human-readable ro errors; an empty list means the value is
 * a usable `ScoringConfig`.
 */
export function validateScoringConfig(form: FormConfig, raw: unknown): string[] {
	const errors: string[] = [];
	if (!isRecord(raw)) return ['Configurația de scor trebuie să fie un obiect JSON.'];

	// bands
	const bands = raw.bands;
	if (!Array.isArray(bands) || bands.length === 0) {
		errors.push('"bands" trebuie să conțină cel puțin o bandă de rezultat.');
	} else {
		const keys = new Set<string>();
		bands.forEach((band, i) => {
			if (
				!isRecord(band) ||
				typeof band.key !== 'string' ||
				typeof band.label !== 'string' ||
				typeof band.advice !== 'string' ||
				typeof band.min !== 'number'
			) {
				errors.push(
					`Banda #${i + 1}: are nevoie de "key", "label", "advice" (text) și "min" (număr).`
				);
				return;
			}
			if (keys.has(band.key)) errors.push(`Banda "${band.key}" apare de două ori.`);
			keys.add(band.key);
		});
		const mins = bands
			.filter((b): b is { min: number } => isRecord(b) && typeof b.min === 'number')
			.map((b) => b.min);
		if (mins.some((min, i) => i > 0 && min <= mins[i - 1])) {
			errors.push('Pragurile "min" ale benzilor trebuie să fie strict crescătoare.');
		}
	}

	// dimensions
	const dimensionKeys = new Set<string>();
	if (raw.dimensions !== undefined) {
		if (!isRecord(raw.dimensions)) {
			errors.push('"dimensions" trebuie să fie un obiect { cheie: { label } }.');
		} else {
			for (const [key, value] of Object.entries(raw.dimensions)) {
				if (!isRecord(value) || typeof value.label !== 'string') {
					errors.push(`Dimensiunea "${key}" are nevoie de un "label" text.`);
				}
				dimensionKeys.add(key);
			}
		}
	}

	// questions
	if (!isRecord(raw.questions)) {
		errors.push('"questions" lipsește sau nu este un obiect.');
		return errors;
	}
	const byId = questionsById(form);
	for (const [questionId, spec] of Object.entries(raw.questions)) {
		const where = `Întrebarea "${questionId}"`;
		const question = byId.get(questionId);
		if (!question) {
			errors.push(`${where} nu există în schema formularului.`);
			continue;
		}
		if (!isRecord(spec) || (spec.kind !== 'map' && spec.kind !== 'numeric')) {
			errors.push(`${where}: "kind" trebuie să fie "map" sau "numeric".`);
			continue;
		}
		if (spec.dimension !== undefined) {
			if (typeof spec.dimension !== 'string' || !dimensionKeys.has(spec.dimension)) {
				errors.push(`${where}: dimensiunea "${String(spec.dimension)}" nu este declarată.`);
			}
		}
		if (spec.kind === 'map') {
			if (!isRecord(spec.map)) {
				errors.push(`${where}: "map" trebuie să fie un obiect { valoare: puncte }.`);
				continue;
			}
			for (const [value, points] of Object.entries(spec.map)) {
				if (typeof points !== 'number') {
					errors.push(`${where}: punctajul pentru "${value}" trebuie să fie un număr.`);
				}
			}
			if (OPTION_TYPES.has(question.type)) {
				const optionValues = new Set((question.options ?? []).map((o) => o.value));
				for (const value of Object.keys(spec.map)) {
					if (!optionValues.has(value)) {
						errors.push(`${where}: valoarea "${value}" nu este printre opțiunile întrebării.`);
					}
				}
			}
		} else {
			if (spec.multiplier !== undefined && typeof spec.multiplier !== 'number') {
				errors.push(`${where}: "multiplier" trebuie să fie un număr.`);
			}
			if (spec.cap !== undefined && typeof spec.cap !== 'number') {
				errors.push(`${where}: "cap" trebuie să fie un număr.`);
			}
		}
	}

	return errors;
}
