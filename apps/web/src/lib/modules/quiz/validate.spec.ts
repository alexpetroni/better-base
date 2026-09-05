import { describe, expect, it } from 'vitest';
import type { QuestionType } from 'formcomp';
import { validateFormSchema } from './validate.ts';

function formWith(type: string) {
	return {
		steps: [
			{
				id: 's',
				label: 'S',
				groups: [
					{
						id: 'g',
						label: 'G',
						questions: [{ id: 'q', type, label: 'Q', options: [{ value: 'a', label: 'A' }] }]
					}
				]
			}
		]
	};
}

// FIX-15 (audit P2 'a published quiz can be saved unrenderable'): the
// structural check accepted any string as a question type; formcomp's own
// validateConfig only ran in the editor's preview pane.
describe('validateFormSchema question types', () => {
	it('rejects a type formcomp cannot render', () => {
		const errors = validateFormSchema(formWith('slider'));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('"slider"');
	});

	it('accepts every formcomp question type', () => {
		const types: QuestionType[] = [
			'single-select',
			'multi-select',
			'select',
			'time-input',
			'date-input',
			'number-input',
			'range',
			'text-input',
			'textarea',
			'likert',
			'scale'
		];
		for (const type of types) expect(validateFormSchema(formWith(type))).toEqual([]);
	});
});
