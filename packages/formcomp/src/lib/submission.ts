import type { FormConfig, SubmitPayload, SubmitAnswer } from './types.js';
import { collectResponses } from './validation/validator.js';
import { formatAnswer } from './format.js';

type GetResponse = (stepId: string, questionId: string) => unknown;
type Translate = (key: string) => string;

/**
 * Build the JSON payload for the configured submit endpoint. Only currently
 * visible answers are included (same visibility fixpoint as
 * `collectResponses`). Each answer carries the question's stable `uuid`
 * (falling back to `id`) so a backend can match answers across quiz
 * revisions, plus the raw value and a human-readable `displayValue`.
 */
export function buildSubmitPayload(
	config: FormConfig,
	getResponse: GetResponse,
	translate: Translate = (k) => k
): SubmitPayload {
	const collected = collectResponses(config, getResponse);
	const answers: SubmitAnswer[] = [];

	for (const step of config.steps) {
		const stepResponses = collected[step.id];
		if (!stepResponses) continue;
		for (const group of step.groups) {
			for (const question of group.questions) {
				if (!(question.id in stepResponses)) continue;
				const value = stepResponses[question.id];
				answers.push({
					uuid: question.uuid ?? question.id,
					questionId: question.id,
					stepId: step.id,
					type: question.type,
					label: translate(question.label),
					value,
					displayValue: formatAnswer(question, value, translate)
				});
			}
		}
	}

	return {
		form: {
			version: config.version,
			submittedAt: new Date().toISOString()
		},
		answers
	};
}
