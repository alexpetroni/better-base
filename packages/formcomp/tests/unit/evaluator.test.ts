import { describe, it, expect } from 'vitest';
import { evaluateCondition, isAnswered } from '../../src/lib/conditions/evaluator.js';
import type { Condition } from '../../src/lib/types.js';

const responses: Record<string, Record<string, unknown>> = {
	s1: { color: 'red', tags: ['a', 'b'], score: 7, empty: '', zero: 0 }
};
const get = (sid: string, qid: string) => responses[sid]?.[qid];

const evaluate = (c: Condition, stepId = 's1') => evaluateCondition(c, get, stepId);

describe('isAnswered', () => {
	it('rejects nullish, empty strings, and empty arrays', () => {
		expect(isAnswered(undefined)).toBe(false);
		expect(isAnswered(null)).toBe(false);
		expect(isAnswered('')).toBe(false);
		expect(isAnswered('   ')).toBe(false);
		expect(isAnswered([])).toBe(false);
	});

	it('accepts numbers (including 0), strings, arrays, and objects', () => {
		expect(isAnswered(0)).toBe(true);
		expect(isAnswered('x')).toBe(true);
		expect(isAnswered(['x'])).toBe(true);
		expect(isAnswered({ from: 1, to: 2 })).toBe(true);
	});
});

describe('simple operators', () => {
	it('equals is strict — no type coercion', () => {
		expect(evaluate({ questionId: 'score', operator: 'equals', value: 7 })).toBe(true);
		expect(evaluate({ questionId: 'score', operator: 'equals', value: '7' })).toBe(false);
	});

	it('not-equals', () => {
		expect(evaluate({ questionId: 'color', operator: 'not-equals', value: 'blue' })).toBe(true);
		expect(evaluate({ questionId: 'color', operator: 'not-equals', value: 'red' })).toBe(false);
	});

	it('includes only matches arrays', () => {
		expect(evaluate({ questionId: 'tags', operator: 'includes', value: 'a' })).toBe(true);
		expect(evaluate({ questionId: 'tags', operator: 'includes', value: 'z' })).toBe(false);
		expect(evaluate({ questionId: 'color', operator: 'includes', value: 'red' })).toBe(false);
	});

	it('not-includes is true for non-arrays', () => {
		expect(evaluate({ questionId: 'tags', operator: 'not-includes', value: 'z' })).toBe(true);
		expect(evaluate({ questionId: 'color', operator: 'not-includes', value: 'red' })).toBe(true);
	});

	it('greater-than / less-than require numbers on both sides', () => {
		expect(evaluate({ questionId: 'score', operator: 'greater-than', value: 5 })).toBe(true);
		expect(evaluate({ questionId: 'score', operator: 'less-than', value: 5 })).toBe(false);
		expect(evaluate({ questionId: 'score', operator: 'greater-than', value: '5' })).toBe(false);
		expect(evaluate({ questionId: 'color', operator: 'greater-than', value: 5 })).toBe(false);
	});

	it('answered / not-answered', () => {
		expect(evaluate({ questionId: 'color', operator: 'answered' })).toBe(true);
		expect(evaluate({ questionId: 'empty', operator: 'answered' })).toBe(false);
		expect(evaluate({ questionId: 'zero', operator: 'answered' })).toBe(true);
		expect(evaluate({ questionId: 'missing', operator: 'not-answered' })).toBe(true);
	});
});

describe('compound conditions', () => {
	it('and / or, including nesting', () => {
		const a: Condition = { questionId: 'color', operator: 'equals', value: 'red' };
		const b: Condition = { questionId: 'score', operator: 'greater-than', value: 100 };

		expect(evaluate({ operator: 'and', conditions: [a, b] })).toBe(false);
		expect(evaluate({ operator: 'or', conditions: [a, b] })).toBe(true);
		expect(
			evaluate({
				operator: 'and',
				conditions: [a, { operator: 'or', conditions: [b, { questionId: 'tags', operator: 'includes', value: 'b' }] }]
			})
		).toBe(true);
	});
});

describe('cross-step lookup', () => {
	it('uses stepId when provided, currentStepId otherwise', () => {
		expect(
			evaluateCondition({ questionId: 'color', operator: 'equals', value: 'red', stepId: 's1' }, get, 'other-step')
		).toBe(true);
		expect(
			evaluateCondition({ questionId: 'color', operator: 'equals', value: 'red' }, get, 'other-step')
		).toBe(false);
	});
});
