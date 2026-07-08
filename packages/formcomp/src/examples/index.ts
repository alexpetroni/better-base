import type { FormConfig } from '../lib/types.js';

import { minimalConfig } from './minimal.js';
import { conditionalConfig } from './conditional.js';
import { likertConfig } from './likert.js';
import { allInputsConfig } from './all-inputs.js';
import { customizedConfig } from './customized.js';
import { kioskConfig } from './kiosk.js';
import { sleepAssessmentConfig } from './sleep-assessment.js';

export interface Example {
	slug: string;
	title: string;
	description: string;
	config: FormConfig;
}

export const examples: Example[] = [
	{
		slug: 'minimal',
		title: 'Minimal form',
		description: 'The smallest useful form — plus result submission: uuid-keyed POST payload, success screen, error handling.',
		config: minimalConfig
	},
	{
		slug: 'conditional',
		title: 'Conditional logic',
		description: 'Show/hide questions, groups, and whole steps: AND/OR, cross-step, numeric (greater-than) and answered operators.',
		config: conditionalConfig
	},
	{
		slug: 'likert',
		title: 'Likert batch',
		description: 'A batch of statements rated on a shared 1–5 agreement scale.',
		config: likertConfig
	},
	{
		slug: 'all-inputs',
		title: 'All input types',
		description: 'Every built-in input — text, email, textarea, selects, scale, range, time, date — plus tooltips and the summary screen.',
		config: allInputsConfig
	},
	{
		slug: 'customized',
		title: 'Settings & styling',
		description: 'Custom button labels, validation messages, summary texts, submit error handling, and class hooks at every level.',
		config: customizedConfig
	},
	{
		slug: 'kiosk',
		title: 'Kiosk (linear flow)',
		description: 'No progress header, no going back: showProgress and allowBackNavigation turned off.',
		config: kioskConfig
	},
	{
		slug: 'sleep-assessment',
		title: 'Sleep assessment',
		description: 'A larger three-step sleep assessment combining conditions, Likert batches, and layout.',
		config: sleepAssessmentConfig
	}
];

export function getExample(slug: string): Example | undefined {
	return examples.find((e) => e.slug === slug);
}

export {
	minimalConfig,
	conditionalConfig,
	likertConfig,
	allInputsConfig,
	customizedConfig,
	kioskConfig,
	sleepAssessmentConfig
};
