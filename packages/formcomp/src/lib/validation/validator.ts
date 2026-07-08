import type { FormConfig, StepConfig, Question, RangeValue } from '../types.js';
import { evaluateCondition, isAnswered } from '../conditions/evaluator.js';

export interface ValidationResult {
	isValid: boolean;
	firstIncompleteGroupId: string | null;
	/** Why the first incomplete group failed: a required answer is missing, or an answer is invalid (e.g. out of range). */
	reason?: 'missing' | 'invalid';
}

type GetResponse = (stepId: string, questionId: string) => unknown;

function isQuestionVisible(
	question: Question,
	getResponse: GetResponse,
	currentStepId: string
): boolean {
	if (!question.condition) return true;
	return evaluateCondition(question.condition, getResponse, currentStepId);
}

/** Validate a single question's answer: ok, a required answer missing, or an invalid answer. */
export function questionStatus(question: Question, value: unknown): 'ok' | 'missing' | 'invalid' {
	if (question.type === 'range') {
		const v = value as RangeValue | undefined | null;
		const from = typeof v?.from === 'number' ? v.from : undefined;
		const to = typeof v?.to === 'number' ? v.to : undefined;
		if (from === undefined && to === undefined) return question.required ? 'missing' : 'ok';
		// A half-filled range counts as missing, even when not required
		if (from === undefined || to === undefined) return 'missing';
		if (question.min !== undefined && from < question.min) return 'invalid';
		if (question.max !== undefined && to > question.max) return 'invalid';
		if (from > to) return 'invalid';
		return 'ok';
	}

	if (!isAnswered(value)) return question.required ? 'missing' : 'ok';

	if (
		(question.type === 'number-input' || question.type === 'scale') &&
		typeof value === 'number'
	) {
		if (question.min !== undefined && value < question.min) return 'invalid';
		if (question.max !== undefined && value > question.max) return 'invalid';
	}

	return 'ok';
}

export function validateStep(
	stepConfig: StepConfig,
	getResponse: GetResponse,
	currentStepId: string
): ValidationResult {
	for (const group of stepConfig.groups) {
		// Skip hidden groups
		if (group.condition) {
			const visible = evaluateCondition(group.condition, getResponse, currentStepId);
			if (!visible) continue;
		}

		for (const question of group.questions) {
			if (!isQuestionVisible(question, getResponse, currentStepId)) continue;

			const status = questionStatus(question, getResponse(currentStepId, question.id));
			if (status !== 'ok') {
				return { isValid: false, firstIncompleteGroupId: group.id, reason: status };
			}
		}
	}

	return { isValid: true, firstIncompleteGroupId: null };
}

/** True when the step is not skipped by its own condition. */
export function isStepVisible(step: StepConfig, getResponse: GetResponse): boolean {
	if (!step.condition) return true;
	return evaluateCondition(step.condition, getResponse, step.id);
}

/**
 * Collect the responses of all currently *visible* steps, groups, and
 * questions. Answers given to questions that were later hidden by a condition
 * are excluded, so the submitted payload always matches what the user saw.
 *
 * Visibility is resolved to a fixpoint: an answer to a hidden question is
 * discarded, which may in turn hide questions whose conditions referenced it,
 * and so on.
 */
export function collectResponses(
	config: FormConfig,
	getResponse: GetResponse
): Record<string, Record<string, unknown>> {
	const collectOnce = (get: GetResponse) => {
		const out: Record<string, Record<string, unknown>> = {};
		for (const step of config.steps) {
			if (!isStepVisible(step, get)) continue;
			const stepResponses: Record<string, unknown> = {};
			for (const group of step.groups) {
				if (group.condition && !evaluateCondition(group.condition, get, step.id)) continue;
				for (const question of group.questions) {
					if (!isQuestionVisible(question, get, step.id)) continue;
					const value = get(step.id, question.id);
					if (value !== undefined) stepResponses[question.id] = value;
				}
			}
			out[step.id] = stepResponses;
		}
		return out;
	};

	const count = (r: Record<string, Record<string, unknown>>) =>
		Object.values(r).reduce((n, step) => n + Object.keys(step).length, 0);

	// Each pass only ever removes answers, so the answer count is strictly
	// decreasing until stable — the loop always terminates.
	let effective = collectOnce(getResponse);
	for (;;) {
		const next = collectOnce((s, q) => effective[s]?.[q]);
		if (count(next) === count(effective)) return next;
		effective = next;
	}
}
