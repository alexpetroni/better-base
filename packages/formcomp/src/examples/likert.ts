import type { FormConfig, QuestionOption } from '../lib/types.js';

const agreement: QuestionOption[] = [
	{ value: '1', label: 'Strongly disagree' },
	{ value: '2', label: 'Disagree' },
	{ value: '3', label: 'Neutral' },
	{ value: '4', label: 'Agree' },
	{ value: '5', label: 'Strongly agree' }
];

export const likertConfig: FormConfig = {
	steps: [
		{
			id: 'job-satisfaction',
			label: 'Job Satisfaction',
			intro: 'Rate how much you agree with each statement.',
			groups: [
				{
					id: 'statements',
					label: 'Please rate the following',
					renderMode: 'likert-batch',
					questions: [
						{
							id: 'meaningful',
							type: 'likert',
							label: 'My work is meaningful to me.',
							required: true,
							options: agreement
						},
						{
							id: 'supported',
							type: 'likert',
							label: 'I feel supported by my manager.',
							required: true,
							options: agreement
						},
						{
							id: 'growth',
							type: 'likert',
							label: 'I have opportunities to grow.',
							required: true,
							options: agreement
						},
						{
							id: 'recommend',
							type: 'likert',
							label: 'I would recommend this workplace to a friend.',
							required: true,
							options: agreement
						}
					]
				},
				{
					id: 'comments',
					label: 'Anything to add?',
					questions: [
						{
							id: 'comment',
							type: 'textarea',
							label: 'Additional comments',
							rows: 4,
							placeholder: 'Optional…'
						}
					]
				}
			]
		}
	]
};
