import { describe, it, expect } from 'vitest';
import { validateConfig } from '../../src/lib/validation/config-check.js';
import type { FormConfig } from '../../src/lib/types.js';

describe('validateConfig', () => {
	it('accepts a well-formed config', () => {
		const config: FormConfig = {
			steps: [
				{
					id: 'a',
					label: 'A',
					groups: [
						{
							id: 'g',
							label: 'G',
							questions: [
								{ id: 'q1', type: 'single-select', label: 'Q1', options: [{ value: 'x', label: 'X' }] },
								{
									id: 'q2',
									type: 'text-input',
									label: 'Q2',
									condition: { questionId: 'q1', operator: 'equals', value: 'x' }
								}
							]
						}
					]
				}
			]
		};
		expect(validateConfig(config)).toEqual([]);
	});

	it('flags duplicates, missing options, bad references, and valueless comparisons', () => {
		const config: FormConfig = {
			steps: [
				{
					id: 'a',
					label: 'A',
					groups: [
						{
							id: 'g',
							label: 'G',
							questions: [
								{ id: 'q1', type: 'single-select', label: '' }, // no options
								{ id: 'q1', type: 'text-input', label: '' }, // duplicate id
								{
									id: 'q3',
									type: 'text-input',
									label: '',
									condition: { questionId: 'nope', operator: 'equals', value: 1 } // unknown question
								},
								{
									id: 'q4',
									type: 'text-input',
									label: '',
									condition: { questionId: 'q1', operator: 'equals' } // missing value
								},
								{
									id: 'q5',
									type: 'text-input',
									label: '',
									condition: { questionId: 'q1', operator: 'equals', value: 1, stepId: 'ghost' } // unknown step
								}
							]
						}
					]
				}
			]
		};
		const warnings = validateConfig(config);
		expect(warnings.some((w) => w.includes('has no options'))).toBe(true);
		expect(warnings.some((w) => w.includes('duplicate question id "q1"'))).toBe(true);
		expect(warnings.some((w) => w.includes('unknown question "nope"'))).toBe(true);
		expect(warnings.some((w) => w.includes('without a value'))).toBe(true);
		expect(warnings.some((w) => w.includes('unknown step "ghost"'))).toBe(true);
	});

	it('flags mismatched likert-batch option sets', () => {
		const options = (values: string[]) => values.map((v) => ({ value: v, label: v }));
		const config: FormConfig = {
			steps: [
				{
					id: 'a',
					label: 'A',
					groups: [
						{
							id: 'g',
							label: 'G',
							renderMode: 'likert-batch',
							questions: [
								{ id: 'q1', type: 'likert', label: '', options: options(['0', '1']) },
								{ id: 'q2', type: 'likert', label: '', options: options(['0', '1', '2']) }
							]
						}
					]
				}
			]
		};
		expect(validateConfig(config).some((w) => w.includes('must share the same options'))).toBe(true);
	});
});
