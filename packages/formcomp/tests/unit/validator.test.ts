import { describe, it, expect } from 'vitest';
import { validateStep, questionStatus, collectResponses, isStepVisible } from '../../src/lib/validation/validator.js';
import type { FormConfig, Question, StepConfig } from '../../src/lib/types.js';

const q = (partial: Partial<Question> & { id: string; type: Question['type'] }): Question => ({
	label: partial.id,
	...partial
});

describe('questionStatus', () => {
	it('required + unanswered → missing; optional + unanswered → ok', () => {
		expect(questionStatus(q({ id: 'a', type: 'text-input', required: true }), undefined)).toBe('missing');
		expect(questionStatus(q({ id: 'a', type: 'text-input' }), undefined)).toBe('ok');
	});

	it('number out of min/max → invalid', () => {
		const question = q({ id: 'age', type: 'number-input', required: true, min: 13, max: 120 });
		expect(questionStatus(question, 999)).toBe('invalid');
		expect(questionStatus(question, 5)).toBe('invalid');
		expect(questionStatus(question, 42)).toBe('ok');
	});

	it('range: empty vs partial vs inverted vs out-of-bounds vs ok', () => {
		const question = q({ id: 'budget', type: 'range', required: true, min: 0, max: 100 });
		expect(questionStatus(question, undefined)).toBe('missing');
		expect(questionStatus({ ...question, required: false }, undefined)).toBe('ok');
		expect(questionStatus(question, { from: 10 })).toBe('missing'); // half-filled
		expect(questionStatus(question, { from: 50, to: 10 })).toBe('invalid'); // inverted
		expect(questionStatus(question, { from: -5, to: 10 })).toBe('invalid');
		expect(questionStatus(question, { from: 10, to: 200 })).toBe('invalid');
		expect(questionStatus(question, { from: 10, to: 50 })).toBe('ok');
	});
});

describe('validateStep', () => {
	const step: StepConfig = {
		id: 's',
		label: 'S',
		groups: [
			{
				id: 'g1',
				label: 'G1',
				questions: [q({ id: 'name', type: 'text-input', required: true })]
			},
			{
				id: 'g2',
				label: 'G2',
				condition: { questionId: 'name', operator: 'equals', value: 'x' },
				questions: [q({ id: 'extra', type: 'text-input', required: true })]
			}
		]
	};

	it('reports the first incomplete group with a reason', () => {
		const result = validateStep(step, () => undefined, 's');
		expect(result).toEqual({ isValid: false, firstIncompleteGroupId: 'g1', reason: 'missing' });
	});

	it('skips groups hidden by conditions', () => {
		// name answered with 'y' → g2 stays hidden and its required question is not enforced
		const get = (_: string, qid: string) => (qid === 'name' ? 'y' : undefined);
		expect(validateStep(step, get, 's').isValid).toBe(true);
	});

	it('enforces questions revealed by conditions', () => {
		const get = (_: string, qid: string) => (qid === 'name' ? 'x' : undefined);
		const result = validateStep(step, get, 's');
		expect(result.firstIncompleteGroupId).toBe('g2');
	});

	it('flags out-of-range answers as invalid', () => {
		const rangeStep: StepConfig = {
			id: 's',
			label: 'S',
			groups: [{ id: 'g', label: 'G', questions: [q({ id: 'n', type: 'number-input', max: 10 })] }]
		};
		const result = validateStep(rangeStep, () => 99, 's');
		expect(result.reason).toBe('invalid');
	});
});

describe('collectResponses', () => {
	const config: FormConfig = {
		steps: [
			{
				id: 'travel',
				label: 'T',
				groups: [
					{
						id: 'plans',
						label: 'P',
						questions: [
							q({ id: 'traveling', type: 'single-select' }),
							q({
								id: 'destinations',
								type: 'multi-select',
								condition: { questionId: 'traveling', operator: 'not-equals', value: 'no' }
							}),
							q({
								id: 'beach_country',
								type: 'text-input',
								condition: { questionId: 'destinations', operator: 'includes', value: 'beach' }
							})
						]
					}
				]
			},
			{
				id: 'details',
				label: 'D',
				condition: { questionId: 'traveling', operator: 'equals', value: 'yes', stepId: 'travel' },
				groups: [{ id: 'g', label: 'G', questions: [q({ id: 'days', type: 'number-input' })] }]
			}
		]
	};

	it('drops transitively hidden answers (fixpoint)', () => {
		const responses: Record<string, Record<string, unknown>> = {
			travel: { traveling: 'no', destinations: ['beach'], beach_country: 'Portugal' },
			details: { days: 10 }
		};
		const collected = collectResponses(config, (s, qid) => responses[s]?.[qid]);
		expect(collected).toEqual({ travel: { traveling: 'no' } });
	});

	it('keeps everything when visible', () => {
		const responses: Record<string, Record<string, unknown>> = {
			travel: { traveling: 'yes', destinations: ['beach'], beach_country: 'Portugal' },
			details: { days: 10 }
		};
		const collected = collectResponses(config, (s, qid) => responses[s]?.[qid]);
		expect(collected).toEqual({
			travel: { traveling: 'yes', destinations: ['beach'], beach_country: 'Portugal' },
			details: { days: 10 }
		});
	});

	it('isStepVisible follows the step condition', () => {
		const step = config.steps[1];
		expect(isStepVisible(step, () => 'yes')).toBe(true);
		expect(isStepVisible(step, () => 'no')).toBe(false);
	});
});
