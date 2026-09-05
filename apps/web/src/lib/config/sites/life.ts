import type { SiteConfig } from '../types.ts';

export const lifeSite: SiteConfig = {
	id: 'life',
	name: 'Better Life',
	domain: 'betterlife.ro',
	// `ro` only until content is localized (FIX-15): drives the subscriber
	// locale and hreflang alternates (none for a single locale).
	locales: ['ro'],
	pillars: ['somn', 'nutritie', 'miscare', 'stres', 'relatii', 'scop', 'mediu', 'minte', 'finante'],
	theme: {
		'color-brand': 'oklch(0.45 0.13 155)',
		'color-brand-soft': 'oklch(0.94 0.04 155)',
		'color-accent': 'oklch(0.65 0.16 40)',
		'color-surface': 'oklch(0.99 0.005 155)',
		'color-ink': 'oklch(0.24 0.03 155)'
	},
	nav: [
		{ label: 'Acasă', href: '/' },
		{ label: 'Sănătate', href: '/sanatate/somn' },
		{ label: 'Blog', href: '/blog' },
		{ label: 'Magazin', href: '/magazin' },
		{ label: 'Asistent', href: '/asistent' }
	],
	footerLinks: [
		{ label: 'Politica de confidențialitate', href: '/pagini/politica-de-confidentialitate' },
		{ label: 'Termeni și condiții', href: '/pagini/termeni-si-conditii' },
		{ label: 'Politica de cookie-uri', href: '/pagini/politica-de-cookie-uri' }
	],
	chatPersonaKey: 'life-coach',
	chatWidget: true,
	email: {
		from: 'salut@betterlife.ro',
		replyTo: 'salut@betterlife.ro'
	},
	// Deliberately DIFFERENT from better-sleep: same code, other data rows.
	nurture: [
		{
			key: 'bun-venit',
			name: 'Bun venit la newsletter',
			trigger: { kind: 'consent-confirmed' },
			consentKey: 'newsletter',
			steps: [
				{
					offsetDays: 0,
					templateKey: 'nurture',
					subject: 'Bine ai venit la Better Life',
					paragraphs: [
						'Îți mulțumim că te-ai abonat! Îți trimitem periodic idei practice din cei nouă piloni ai unei vieți mai bune — somn, nutriție, mișcare și restul.',
						'Începe cu pilonul care te interesează cel mai mult.'
					],
					cta: { label: 'Explorează pilonii', url: '/sanatate/somn' }
				},
				{
					offsetDays: 7,
					hourLocal: 9,
					templateKey: 'nurture',
					subject: 'Un pilon pe săptămână',
					paragraphs: [
						'Nu încerca să schimbi totul deodată: alege un singur pilon și dă-i o săptămână întreagă. Progresul mic și constant bate entuziasmul de trei zile.'
					]
				}
			]
		}
	]
};
