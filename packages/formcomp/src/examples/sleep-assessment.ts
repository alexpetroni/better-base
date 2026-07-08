import type { FormConfig } from '../lib/types.js';

export const sleepAssessmentConfig: FormConfig = {
	steps: [
		{
			id: 'sleep-patterns',
			label: 'Sleep Patterns',
			intro: 'Tell us about your current sleep schedule and habits.',
			groups: [
				{
					id: 'schedule',
					label: 'Sleep Schedule',
					renderMode: 'inline',
					layout: { columns: 2 },
					questions: [
						{ id: 'bedtime', type: 'time-input', label: 'Usual bedtime', required: true, step: 900 },
						{ id: 'waketime', type: 'time-input', label: 'Usual wake time', required: true, step: 900 }
					]
				},
				{
					id: 'sleep-onset',
					label: 'Sleep Onset',
					questions: [
						{
							id: 'time_to_fall_asleep',
							type: 'number-input',
							label: 'How long does it take you to fall asleep? (minutes)',
							required: true,
							min: 0,
							max: 300,
							placeholder: '30',
							unit: 'min'
						}
					]
				},
				{
					id: 'primary-complaint',
					label: 'Primary Sleep Complaint',
					questions: [
						{
							id: 'primary_complaint',
							type: 'single-select',
							label: 'What is your main sleep issue?',
							displayVariant: 'card',
							required: true,
							options: [
								{ value: 'falling_asleep', label: 'Difficulty falling asleep', description: 'Takes more than 30 minutes to fall asleep' },
								{ value: 'staying_asleep', label: 'Difficulty staying asleep', description: 'Wake up multiple times during the night' },
								{ value: 'early_waking', label: 'Waking up too early', description: 'Wake up earlier than desired and cannot fall back asleep' },
								{ value: 'unrefreshing', label: 'Unrefreshing sleep', description: 'Sleep enough hours but still feel tired' },
								{ value: 'other', label: 'Other', description: 'Something else not listed above' }
							]
						}
					]
				},
				{
					id: 'other-details',
					label: 'Other Details',
					condition: { questionId: 'primary_complaint', operator: 'equals', value: 'other' },
					questions: [
						{
							id: 'other_complaint_text',
							type: 'textarea',
							label: 'Please describe your sleep concern',
							required: true,
							rows: 3,
							placeholder: 'Describe what you experience…'
						}
					]
				},
				{
					id: 'sleep-severity',
					label: 'Insomnia Severity',
					intro: 'Rate each of the following over the past 2 weeks.',
					renderMode: 'likert-batch',
					questions: [
						{
							id: 'isi_falling_asleep',
							type: 'likert',
							label: 'Difficulty falling asleep',
							required: true,
							options: [
								{ value: '0', label: 'None' },
								{ value: '1', label: 'Mild' },
								{ value: '2', label: 'Moderate' },
								{ value: '3', label: 'Severe' },
								{ value: '4', label: 'Very Severe' }
							]
						},
						{
							id: 'isi_staying_asleep',
							type: 'likert',
							label: 'Difficulty staying asleep',
							required: true,
							options: [
								{ value: '0', label: 'None' },
								{ value: '1', label: 'Mild' },
								{ value: '2', label: 'Moderate' },
								{ value: '3', label: 'Severe' },
								{ value: '4', label: 'Very Severe' }
							]
						},
						{
							id: 'isi_early_waking',
							type: 'likert',
							label: 'Problem waking too early',
							required: true,
							options: [
								{ value: '0', label: 'None' },
								{ value: '1', label: 'Mild' },
								{ value: '2', label: 'Moderate' },
								{ value: '3', label: 'Severe' },
								{ value: '4', label: 'Very Severe' }
							]
						}
					]
				}
			]
		},
		{
			id: 'environment',
			label: 'Sleep Environment',
			intro: 'Tell us about your sleeping environment and evening habits.',
			groups: [
				{
					id: 'room-conditions',
					label: 'Room Conditions',
					questions: [
						{
							id: 'darkness',
							type: 'single-select',
							label: 'How dark is your bedroom when you sleep?',
							required: true,
							options: [
								{ value: 'very_dark', label: 'Very dark (no light sources)' },
								{ value: 'mostly_dark', label: 'Mostly dark (some light)' },
								{ value: 'somewhat_light', label: 'Somewhat light' },
								{ value: 'quite_light', label: 'Quite light (streetlight, etc.)' }
							]
						},
						{
							id: 'noise_level',
							type: 'scale',
							label: 'Rate the noise level in your bedroom',
							required: true,
							min: 1,
							max: 10,
							minLabel: 'Silent',
							maxLabel: 'Very noisy'
						}
					]
				},
				{
					id: 'evening-habits',
					label: 'Evening Activities',
					questions: [
						{
							id: 'evening_activities',
							type: 'multi-select',
							label: 'What do you typically do in the hour before bed?',
							required: true,
							options: [
								{ value: 'screen', label: 'Phone/tablet/computer', description: 'Browsing, social media, etc.' },
								{ value: 'tv', label: 'Watch TV', description: 'Television or streaming' },
								{ value: 'reading', label: 'Read a book', description: 'Physical book or e-reader' },
								{ value: 'meditation', label: 'Meditation or relaxation' },
								{ value: 'exercise', label: 'Exercise or stretching' },
								{ value: 'work', label: 'Work-related tasks' },
								{ value: 'none', label: 'None of these', exclusive: true }
							]
						}
					]
				},
				{
					id: 'bed-sharing',
					label: 'Bed Sharing',
					questions: [
						{
							id: 'shares_bed',
							type: 'single-select',
							label: 'Do you share your bed with anyone?',
							required: true,
							options: [
								{ value: 'yes_partner', label: 'Yes, with a partner' },
								{ value: 'yes_child', label: 'Yes, with a child' },
								{ value: 'no', label: 'No, I sleep alone' }
							]
						}
					]
				}
			]
		},
		{
			id: 'physical',
			label: 'Physical Profile',
			intro: 'Some physical factors that may affect your sleep.',
			groups: [
				{
					id: 'demographics',
					label: 'Basic Information',
					renderMode: 'inline',
					layout: { columns: 2 },
					questions: [
						{ id: 'age', type: 'number-input', label: 'Age', required: true, min: 13, max: 120, placeholder: '35' },
						{
							id: 'biological_sex',
							type: 'single-select',
							label: 'Biological sex',
							required: true,
							options: [
								{ value: 'male', label: 'Male' },
								{ value: 'female', label: 'Female' }
							]
						}
					]
				},
				{
					id: 'body-metrics',
					label: 'Body Metrics',
					renderMode: 'inline',
					layout: { columns: 2 },
					questions: [
						{ id: 'height', type: 'number-input', label: 'Height', required: true, min: 50, max: 250, unit: 'cm' },
						{ id: 'weight', type: 'number-input', label: 'Weight', required: true, min: 20, max: 300, unit: 'kg' }
					]
				},
				{
					id: 'symptoms',
					label: 'Sleep-Related Symptoms',
					questions: [
						{
							id: 'snoring',
							type: 'single-select',
							label: 'Do you snore?',
							required: true,
							options: [
								{ value: 'no', label: 'No' },
								{ value: 'sometimes', label: 'Sometimes' },
								{ value: 'often', label: 'Often' },
								{ value: 'dont_know', label: "I don't know" }
							]
						},
						{
							id: 'restless_legs',
							type: 'single-select',
							label: 'Do you experience restless legs before sleep?',
							required: true,
							options: [
								{ value: 'no', label: 'No' },
								{ value: 'sometimes', label: 'Sometimes' },
								{ value: 'often', label: 'Often' }
							]
						},
						{
							id: 'restless_relief',
							type: 'single-select',
							label: 'Does moving your legs provide relief?',
							required: true,
							condition: { questionId: 'restless_legs', operator: 'not-equals', value: 'no' },
							options: [
								{ value: 'yes', label: 'Yes' },
								{ value: 'somewhat', label: 'Somewhat' },
								{ value: 'no', label: 'No' }
							]
						}
					]
				},
				{
					id: 'hormonal',
					label: 'Hormonal Factors',
					condition: { questionId: 'biological_sex', operator: 'equals', value: 'female' },
					questions: [
						{
							id: 'hormonal_status',
							type: 'single-select',
							label: 'Current hormonal status',
							required: true,
							options: [
								{ value: 'regular_cycle', label: 'Regular menstrual cycle' },
								{ value: 'irregular_cycle', label: 'Irregular cycle' },
								{ value: 'pregnant', label: 'Pregnant' },
								{ value: 'postpartum', label: 'Postpartum' },
								{ value: 'perimenopause', label: 'Perimenopause' },
								{ value: 'menopause', label: 'Post-menopause' },
								{ value: 'na', label: 'Prefer not to say' }
							]
						}
					]
				}
			]
		}
	]
};
