import type { FormConfig } from '../lib/types.js';

export const minimalConfig: FormConfig = {
	version: 1,
	// The results are POSTed here as JSON; each answer carries the question's
	// stable uuid. (This demo endpoint doesn't exist — submitting in the
	// sandbox shows the built-in error handling.)
	submit: {
		url: '/api/minimal-demo'
	},
	settings: {
		successTitle: 'Message sent!',
		successMessage: 'Thanks for reaching out — we will get back to you.'
	},
	steps: [
		{
			id: 'contact',
			label: 'Contact',
			intro: 'A minimal single-step form.',
			groups: [
				{
					id: 'name-group',
					label: 'Your Name',
					questions: [
						{
							id: 'full_name',
							uuid: '3f1c2d84-6b1a-4f0e-9c5d-000000000001',
							type: 'text-input',
							label: 'Full name',
							required: true,
							placeholder: 'Jane Doe'
						}
					]
				},
				{
					id: 'message-group',
					label: 'Message',
					questions: [
						{
							id: 'message',
							uuid: '3f1c2d84-6b1a-4f0e-9c5d-000000000002',
							type: 'textarea',
							label: 'What would you like to say?',
							required: true,
							rows: 4,
							placeholder: 'Type your message here…'
						}
					]
				}
			]
		}
	]
};
