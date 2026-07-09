import type { FormConfig } from 'formcomp';
import { validateScoringConfig, type ScoringConfig } from './scoring.ts';
import { isRecord } from '../../util/object.ts';

/**
 * Structural validation for admin-authored quiz JSON. Deliberately does NOT
 * runtime-import the formcomp package (its barrel pulls in .svelte components,
 * which plain-node contexts like the seed script cannot load) — formcomp's own
 * `validateConfig` runs client-side in the editor preview pane instead.
 */

/** ro errors; empty list ⇒ `raw` is a renderable FormConfig. */
export function validateFormSchema(raw: unknown): string[] {
	const errors: string[] = [];
	if (!isRecord(raw)) return ['Schema formularului trebuie să fie un obiect JSON.'];
	if (!Array.isArray(raw.steps)) return ['Schema formularului are nevoie de un "steps" (listă).'];

	const questionIds = new Set<string>();
	raw.steps.forEach((step, si) => {
		const stepWhere = `Pasul #${si + 1}`;
		if (!isRecord(step) || typeof step.id !== 'string' || typeof step.label !== 'string') {
			errors.push(`${stepWhere}: are nevoie de "id" și "label" (text).`);
			return;
		}
		if (!Array.isArray(step.groups)) {
			errors.push(`${stepWhere} ("${step.id}"): are nevoie de "groups" (listă).`);
			return;
		}
		step.groups.forEach((group, gi) => {
			const groupWhere = `${stepWhere}, grupul #${gi + 1}`;
			if (!isRecord(group) || typeof group.id !== 'string' || typeof group.label !== 'string') {
				errors.push(`${groupWhere}: are nevoie de "id" și "label" (text).`);
				return;
			}
			if (!Array.isArray(group.questions)) {
				errors.push(`${groupWhere} ("${group.id}"): are nevoie de "questions" (listă).`);
				return;
			}
			group.questions.forEach((question, qi) => {
				const qWhere = `${groupWhere}, întrebarea #${qi + 1}`;
				if (
					!isRecord(question) ||
					typeof question.id !== 'string' ||
					typeof question.type !== 'string' ||
					typeof question.label !== 'string'
				) {
					errors.push(`${qWhere}: are nevoie de "id", "type" și "label" (text).`);
					return;
				}
				if (questionIds.has(question.id)) {
					errors.push(`${qWhere}: id-ul "${question.id}" se repetă în formular.`);
				}
				questionIds.add(question.id);
				if (question.options !== undefined) {
					const ok =
						Array.isArray(question.options) &&
						question.options.every(
							(o) => isRecord(o) && typeof o.value === 'string' && typeof o.label === 'string'
						);
					if (!ok) {
						errors.push(
							`${qWhere} ("${question.id}"): "options" trebuie să fie o listă de { value, label }.`
						);
					}
				}
			});
		});
	});
	return errors;
}

export function countQuestions(form: FormConfig): number {
	return form.steps.reduce(
		(sum, step) => sum + step.groups.reduce((s, g) => s + g.questions.length, 0),
		0
	);
}

/** Everything that must hold before a quiz may go live. */
export function validateForPublish(form: FormConfig, scoring: ScoringConfig): string[] {
	const errors = [...validateFormSchema(form), ...validateScoringConfig(form, scoring)];
	if (errors.length === 0 && countQuestions(form) === 0) {
		errors.push('Un chestionar publicat are nevoie de cel puțin o întrebare.');
	}
	return errors;
}
