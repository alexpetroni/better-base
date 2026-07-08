import type { FormConfig, Condition, Question, StepConfig } from '../types.js';

const OPTION_TYPES = new Set(['single-select', 'multi-select', 'select', 'likert']);
const VALUE_OPERATORS = new Set(['equals', 'not-equals', 'includes', 'not-includes', 'greater-than', 'less-than']);

/**
 * Sanity-check a form config and return a list of human-readable warnings.
 * MultiStepForm runs this automatically in dev mode and logs the results;
 * it can also be called directly (e.g. in a config unit test).
 */
export function validateConfig(config: FormConfig): string[] {
	const warnings: string[] = [];
	const stepIds = new Set<string>();
	// question ids per step, for condition reference checks
	const questionIds = new Map<string, Set<string>>();
	// uuids must be unique across the whole form — they key answers in the submission payload
	const uuids = new Set<string>();

	for (const step of config.steps) {
		if (stepIds.has(step.id)) warnings.push(`Duplicate step id "${step.id}"`);
		stepIds.add(step.id);

		const qids = new Set<string>();
		questionIds.set(step.id, qids);
		const groupIds = new Set<string>();

		for (const group of step.groups) {
			if (groupIds.has(group.id)) warnings.push(`Step "${step.id}": duplicate group id "${group.id}"`);
			groupIds.add(group.id);

			for (const question of group.questions) {
				if (qids.has(question.id)) {
					warnings.push(`Step "${step.id}": duplicate question id "${question.id}"`);
				}
				qids.add(question.id);

				if (OPTION_TYPES.has(question.type) && !question.options?.length) {
					warnings.push(`Question "${question.id}" (${question.type}) has no options`);
				}

				if (question.uuid) {
					if (uuids.has(question.uuid)) {
						warnings.push(`Duplicate question uuid "${question.uuid}"`);
					}
					uuids.add(question.uuid);
				}
			}

			if (group.renderMode === 'likert-batch') {
				checkLikertBatch(step, group.questions, warnings);
			}
		}
	}

	// Condition references — checked after collecting all ids so forward references work
	for (const step of config.steps) {
		if (step.condition) checkCondition(step.condition, `step "${step.id}"`, step, questionIds, warnings);
		for (const group of step.groups) {
			if (group.condition) checkCondition(group.condition, `group "${group.id}"`, step, questionIds, warnings);
			for (const question of group.questions) {
				if (question.condition) {
					checkCondition(question.condition, `question "${question.id}"`, step, questionIds, warnings);
				}
			}
		}
	}

	return warnings;
}

function checkLikertBatch(step: StepConfig, questions: Question[], warnings: string[]) {
	const first = questions[0]?.options?.map((o) => o.value).join('|');
	for (const q of questions.slice(1)) {
		const values = q.options?.map((o) => o.value).join('|');
		if (values !== first) {
			warnings.push(
				`Step "${step.id}": likert-batch questions must share the same options; "${q.id}" differs from "${questions[0].id}"`
			);
		}
	}
}

function checkCondition(
	condition: Condition,
	where: string,
	step: StepConfig,
	questionIds: Map<string, Set<string>>,
	warnings: string[]
) {
	if ('conditions' in condition) {
		for (const c of condition.conditions) checkCondition(c, where, step, questionIds, warnings);
		return;
	}
	const targetStepId = condition.stepId ?? step.id;
	const qids = questionIds.get(targetStepId);
	if (!qids) {
		warnings.push(`Condition on ${where} references unknown step "${targetStepId}"`);
	} else if (!qids.has(condition.questionId)) {
		warnings.push(`Condition on ${where} references unknown question "${condition.questionId}" in step "${targetStepId}"`);
	}
	if (VALUE_OPERATORS.has(condition.operator) && condition.value === undefined) {
		warnings.push(`Condition on ${where} uses operator "${condition.operator}" without a value`);
	}
}
