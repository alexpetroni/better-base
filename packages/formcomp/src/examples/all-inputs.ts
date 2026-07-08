import type { FormConfig } from '../lib/types.js';

export const allInputsConfig: FormConfig = {
	settings: {
		showSummary: true
	},
	steps: [
		{
			id: 'text',
			label: 'Text',
			intro: 'Plain text inputs.',
			groups: [
				{
					id: 'text-inputs',
					label: 'Short & long text',
					intro: 'A group-level intro paragraph, and a tooltip on the name field.',
					questions: [
						{
							id: 'name',
							type: 'text-input',
							label: 'Name',
							tooltip: 'First and last name, as on official documents.',
							required: true,
							placeholder: 'Ada Lovelace'
						},
						{
							id: 'email',
							type: 'text-input',
							inputType: 'email',
							label: 'Email',
							placeholder: 'ada@example.com'
						},
						{
							id: 'bio',
							type: 'textarea',
							label: 'Short bio',
							rows: 4,
							placeholder: 'A few sentences about yourself…'
						}
					]
				}
			]
		},
		{
			id: 'choice',
			label: 'Choice',
			intro: 'Single-select (list and card) plus multi-select.',
			groups: [
				{
					id: 'single-list',
					label: 'Single select — list variant',
					questions: [
						{
							id: 'role',
							type: 'single-select',
							label: 'What best describes your role?',
							required: true,
							options: [
								{ value: 'eng', label: 'Engineer' },
								{ value: 'design', label: 'Designer' },
								{ value: 'pm', label: 'Product manager' },
								{ value: 'other', label: 'Something else' }
							]
						}
					]
				},
				{
					id: 'single-card',
					label: 'Single select — card variant',
					questions: [
						{
							id: 'plan',
							type: 'single-select',
							label: 'Choose a plan',
							displayVariant: 'card',
							required: true,
							options: [
								{ value: 'free', label: 'Free', description: 'All the basics, no cost.' },
								{ value: 'pro', label: 'Pro', description: 'More power, for individuals.' },
								{ value: 'team', label: 'Team', description: 'Collaboration features.' }
							]
						}
					]
				},
				{
					id: 'dropdown',
					label: 'Dropdown select',
					questions: [
						{
							id: 'country',
							type: 'select',
							label: 'Country',
							required: true,
							placeholder: 'Choose a country…',
							options: [
								{ value: 'de', label: 'Germany' },
								{ value: 'fr', label: 'France' },
								{ value: 'pt', label: 'Portugal' },
								{ value: 'ro', label: 'Romania' },
								{ value: 'other', label: 'Other' }
							]
						}
					]
				},
				{
					id: 'multi',
					label: 'Multi select',
					questions: [
						{
							id: 'interests',
							type: 'multi-select',
							label: 'Pick any that apply',
							required: true,
							options: [
								{ value: 'music', label: 'Music' },
								{ value: 'sports', label: 'Sports' },
								{ value: 'reading', label: 'Reading' },
								{ value: 'cooking', label: 'Cooking' },
								{ value: 'none', label: 'None of these', exclusive: true }
							]
						}
					]
				}
			]
		},
		{
			id: 'numbers-and-time',
			label: 'Numbers & Time',
			groups: [
				{
					id: 'metrics',
					label: 'Body metrics',
					renderMode: 'inline',
					layout: { columns: 2 },
					questions: [
						{
							id: 'height',
							type: 'number-input',
							label: 'Height',
							required: true,
							min: 50,
							max: 250,
							unit: 'cm'
						},
						{
							id: 'weight',
							type: 'number-input',
							label: 'Weight',
							required: true,
							min: 20,
							max: 300,
							unit: 'kg'
						}
					]
				},
				{
					id: 'scale',
					label: 'Scale (1–10)',
					questions: [
						{
							id: 'mood',
							type: 'scale',
							label: 'How is your mood today?',
							required: true,
							min: 1,
							max: 10,
							minLabel: 'Awful',
							maxLabel: 'Great'
						}
					]
				},
				{
					id: 'budget-range',
					label: 'Range',
					questions: [
						{
							id: 'budget',
							type: 'range',
							label: 'Monthly budget',
							required: true,
							min: 0,
							max: 10000,
							step: 100,
							unit: '€',
							minLabel: 'At least',
							maxLabel: 'At most'
						}
					]
				},
				{
					id: 'times',
					label: 'Time & date',
					renderMode: 'inline',
					layout: { columns: 2 },
					questions: [
						{
							id: 'start',
							type: 'time-input',
							label: 'Workday start',
							required: true,
							step: 900
						},
						{
							id: 'end',
							type: 'time-input',
							label: 'Workday end',
							required: true,
							step: 900
						},
						{
							id: 'start_date',
							type: 'date-input',
							label: 'Available from',
							required: true
						}
					]
				}
			]
		}
	]
};
