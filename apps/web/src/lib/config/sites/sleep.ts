import type { SiteConfig } from '../types.ts';

export const sleepSite: SiteConfig = {
	id: 'sleep',
	name: 'Better Sleep',
	domain: 'bettersleep.ro',
	locales: ['ro', 'en'],
	pillars: ['somn'],
	theme: {
		'color-brand': 'oklch(0.45 0.14 275)',
		'color-brand-soft': 'oklch(0.93 0.03 275)',
		'color-accent': 'oklch(0.72 0.15 60)',
		'color-surface': 'oklch(0.99 0.005 275)',
		'color-ink': 'oklch(0.22 0.03 275)'
	},
	nav: [
		{ label: 'Acasă', href: '/' },
		{ label: 'Somn', href: '/sanatate/somn' },
		{ label: 'Blog', href: '/blog' }
	],
	chatPersonaKey: 'sleep-coach',
	email: {
		from: 'salut@bettersleep.ro',
		replyTo: 'salut@bettersleep.ro'
	}
};
