import type { Question, RangeValue } from './types.js';

type Translate = (key: string) => string;

/**
 * Format an answer for human consumption: option labels instead of raw
 * values, formatted ranges, unit suffixes. Used by the summary screen and
 * the submission payload's `displayValue`.
 */
export function formatAnswer(
	question: Question,
	value: unknown,
	translate: Translate = (k) => k
): string {
	if (value === undefined || value === null || value === '') return '—';

	const optionLabel = (v: unknown) => {
		const option = question.options?.find((o) => o.value === v);
		return option ? translate(option.label) : String(v);
	};
	const unit = question.unit ? ` ${translate(question.unit)}` : '';

	switch (question.type) {
		case 'single-select':
		case 'select':
		case 'likert':
			return optionLabel(value);
		case 'multi-select':
			return Array.isArray(value) && value.length > 0
				? value.map(optionLabel).join(', ')
				: '—';
		case 'range': {
			const v = value as RangeValue;
			return `${v.from ?? '—'} – ${v.to ?? '—'}${unit}`;
		}
		case 'number-input':
		case 'scale':
			return `${value}${unit}`;
		default:
			return String(value);
	}
}
