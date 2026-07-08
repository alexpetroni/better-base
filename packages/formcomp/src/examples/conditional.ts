import type { FormConfig } from '../lib/types.js';

export const conditionalConfig: FormConfig = {
	steps: [
		{
			id: 'travel',
			label: 'Travel Preferences',
			intro: 'See how conditions hide and show questions as you answer.',
			groups: [
				{
					id: 'plans',
					label: 'Plans',
					questions: [
						{
							id: 'traveling',
							type: 'single-select',
							label: 'Are you planning to travel this year?',
							required: true,
							options: [
								{ value: 'yes', label: 'Yes' },
								{ value: 'no', label: 'No' },
								{ value: 'unsure', label: 'Not sure yet' }
							]
						},
						{
							id: 'destinations',
							type: 'multi-select',
							label: 'Which destinations interest you?',
							required: true,
							condition: { questionId: 'traveling', operator: 'not-equals', value: 'no' },
							options: [
								{ value: 'beach', label: 'Beach' },
								{ value: 'mountains', label: 'Mountains' },
								{ value: 'city', label: 'City break' },
								{ value: 'wildlife', label: 'Wildlife / nature' },
								{ value: 'none', label: 'None of these', exclusive: true }
							]
						},
						{
							id: 'beach_country',
							type: 'text-input',
							label: 'Any specific beach country in mind?',
							placeholder: 'e.g. Portugal',
							condition: {
								operator: 'and',
								conditions: [
									{ questionId: 'traveling', operator: 'equals', value: 'yes' },
									{ questionId: 'destinations', operator: 'includes', value: 'beach' }
								]
							}
						},
						{
							id: 'no_travel_reason',
							type: 'textarea',
							label: 'What is keeping you from traveling?',
							rows: 3,
							condition: { questionId: 'traveling', operator: 'equals', value: 'no' }
						}
					]
				}
			]
		},
		{
			id: 'trip-details',
			label: 'Trip Details',
			intro: 'This entire step is skipped unless you answered "Yes" on the first step.',
			condition: { questionId: 'traveling', operator: 'equals', value: 'yes', stepId: 'travel' },
			groups: [
				{
					id: 'trip',
					label: 'Your Trip',
					questions: [
						{
							id: 'trip_length',
							type: 'number-input',
							label: 'How many days will you travel?',
							required: true,
							min: 1,
							max: 365,
							unit: 'days'
						}
					]
				}
			]
		},
		{
			id: 'follow-up',
			label: 'Follow-up',
			groups: [
				{
					id: 'budget',
					label: 'Budget',
					condition: {
						questionId: 'traveling',
						operator: 'not-equals',
						value: 'no',
						stepId: 'travel'
					},
					questions: [
						{
							id: 'budget',
							type: 'scale',
							label: 'How flexible is your budget?',
							required: true,
							min: 1,
							max: 5,
							minLabel: 'Tight',
							maxLabel: 'Very flexible'
						}
					]
				},
				{
					id: 'splurge',
					label: 'Splurge',
					// Numeric operator: the scale above stores a NUMBER, so compare
					// with a number (value: 3, not '3')
					condition: { questionId: 'budget', operator: 'greater-than', value: 3 },
					questions: [
						{
							id: 'splurge_on',
							type: 'text-input',
							label: 'With a flexible budget — what would you splurge on?',
							placeholder: 'e.g. business class, a nicer hotel…'
						}
					]
				},
				{
					id: 'contact',
					label: 'Email',
					questions: [
						{
							id: 'email',
							type: 'text-input',
							inputType: 'email',
							label: 'Email (optional)',
							placeholder: 'you@example.com'
						},
						{
							id: 'newsletter_topics',
							type: 'multi-select',
							label: 'Which topics should we email you about?',
							// 'answered' needs no value — shown once the email field is filled
							condition: { questionId: 'email', operator: 'answered' },
							options: [
								{ value: 'deals', label: 'Deals' },
								{ value: 'guides', label: 'Destination guides' },
								{ value: 'news', label: 'Travel news' }
							]
						}
					]
				}
			]
		}
	]
};
