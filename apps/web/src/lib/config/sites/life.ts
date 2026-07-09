import type { SiteConfig } from '../types.ts';

export const lifeSite: SiteConfig = {
	id: 'life',
	name: 'Better Life',
	domain: 'betterlife.ro',
	locales: ['ro', 'en'],
	pillars: ['somn', 'nutritie', 'miscare', 'stres', 'relatii', 'scop', 'mediu', 'minte', 'finante'],
	theme: {
		'color-brand': 'oklch(0.52 0.13 155)',
		'color-brand-soft': 'oklch(0.94 0.04 155)',
		'color-accent': 'oklch(0.65 0.16 40)',
		'color-surface': 'oklch(0.99 0.005 155)',
		'color-ink': 'oklch(0.24 0.03 155)'
	},
	nav: [
		{ label: 'Acasă', href: '/' },
		{ label: 'Sănătate', href: '/sanatate/somn' },
		{ label: 'Blog', href: '/blog' },
		{ label: 'Magazin', href: '/magazin' }
	],
	chatPersonaKey: 'life-coach',
	email: {
		from: 'salut@betterlife.ro',
		replyTo: 'salut@betterlife.ro'
	}
};
