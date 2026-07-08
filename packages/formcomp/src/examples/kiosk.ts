import type { FormConfig } from '../lib/types.js';

/**
 * A strictly linear, one-way flow:
 * - `showProgress: false` hides the step header entirely
 * - `allowBackNavigation: false` removes the Back button (and would disable
 *   progress-header clicks, if the header were shown)
 *
 * Useful for kiosk surveys or flows where revisiting answers is not allowed.
 */
export const kioskConfig: FormConfig = {
	settings: {
		showProgress: false,
		allowBackNavigation: false,
		nextLabel: 'Continue'
	},
	steps: [
		{
			id: 'q1',
			label: 'Question 1',
			groups: [
				{
					id: 'g1',
					label: 'First impression',
					questions: [
						{
							id: 'rating',
							type: 'scale',
							label: 'How was your visit today?',
							required: true,
							min: 1,
							max: 5,
							minLabel: 'Poor',
							maxLabel: 'Excellent'
						}
					]
				}
			]
		},
		{
			id: 'q2',
			label: 'Question 2',
			groups: [
				{
					id: 'g2',
					label: 'One more thing',
					questions: [
						{
							id: 'return_visit',
							type: 'single-select',
							label: 'Would you come back?',
							required: true,
							options: [
								{ value: 'yes', label: 'Yes' },
								{ value: 'maybe', label: 'Maybe' },
								{ value: 'no', label: 'No' }
							]
						}
					]
				}
			]
		}
	]
};
