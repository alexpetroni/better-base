import type { FormConfig } from '../lib/types.js';

/**
 * Every cosmetic knob in one place:
 * - `settings`: custom button labels, validation messages, summary heading /
 *   edit label, success screen texts
 * - class hooks at each level (`config.class`, step/group/question `class`,
 *   `optionClass`) — merged with tailwind-merge, so they override defaults
 * - `submit` with a custom error message (the demo endpoint doesn't exist,
 *   so submitting shows the error + retry flow)
 */
export const customizedConfig: FormConfig = {
	version: 1,
	class: 'max-w-2xl',
	submit: {
		url: '/api/customized-demo'
		// successUrl: '/thank-you'  // ← navigate to your own page instead of
		//                                the built-in success screen
	},
	settings: {
		nextLabel: 'Continue',
		backLabel: 'Previous',
		submitLabel: 'Send my answers',
		requiredMessage: 'A required answer is missing here.',
		invalidMessage: 'One of these values is out of the allowed range.',
		showSummary: true,
		summaryLabel: 'Check your answers before sending',
		editLabel: 'Change',
		successTitle: 'All done!',
		successMessage: 'We received your answers.',
		submitErrorMessage: 'Could not reach the server — please try again.'
	},
	steps: [
		{
			id: 'taste',
			label: 'Taste',
			class: 'space-y-10',
			groups: [
				{
					id: 'style',
					label: 'Style',
					intro: 'This group is restyled via its `class` hook.',
					class: 'rounded-xl border border-(--form-border) bg-(--form-accent)/5 p-6',
					questions: [
						{
							id: 'vibe',
							type: 'single-select',
							label: 'Pick a vibe',
							displayVariant: 'card',
							required: true,
							// per-option styling
							optionClass: 'border-dashed',
							layout: { columns: 3 },
							options: [
								{ value: 'minimal', label: 'Minimal', description: 'Less is more' },
								{ value: 'playful', label: 'Playful', description: 'Color and motion' },
								{ value: 'classic', label: 'Classic', description: 'Timeless' }
							]
						}
					]
				}
			]
		},
		{
			id: 'details',
			label: 'Details',
			groups: [
				{
					id: 'numbers',
					label: 'A bounded number and a range',
					intro: 'Enter an inverted range (From greater than To) and press Continue to see the custom invalidMessage.',
					questions: [
						{
							id: 'team_size',
							type: 'number-input',
							label: 'Team size',
							required: true,
							min: 1,
							max: 500,
							unit: 'people'
						},
						{
							id: 'headcount_range',
							type: 'range',
							label: 'Expected headcount next year',
							required: true,
							min: 1,
							max: 1000,
							minLabel: 'At least',
							maxLabel: 'At most'
						}
					]
				}
			]
		}
	]
};
