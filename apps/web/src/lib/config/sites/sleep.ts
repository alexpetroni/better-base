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
		{ label: 'Blog', href: '/blog' },
		{ label: 'Magazin', href: '/magazin' },
		{ label: 'Asistent', href: '/asistent' }
	],
	footerLinks: [
		{ label: 'Politica de confidențialitate', href: '/pagini/politica-de-confidentialitate' },
		{ label: 'Termeni și condiții', href: '/pagini/termeni-si-conditii' },
		{ label: 'Politica de cookie-uri', href: '/pagini/politica-de-cookie-uri' }
	],
	chatPersonaKey: 'sleep-coach',
	chatWidget: true,
	email: {
		from: 'salut@bettersleep.ro',
		replyTo: 'salut@bettersleep.ro'
	},
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
					subject: 'Bine ai venit la Better Sleep',
					paragraphs: [
						'Îți mulțumim că te-ai abonat! De aici înainte îți trimitem, din când în când, sfaturi practice pentru un somn mai bun — fără spam, fără zgomot.',
						'Un prim pas bun: evaluează-ți somnul cu testul nostru de 3 minute.'
					],
					cta: { label: 'Fă testul de somn', url: '/quiz/evaluare-somn' }
				},
				{
					offsetDays: 3,
					hourLocal: 9,
					templateKey: 'nurture',
					subject: '3 obiceiuri simple pentru un somn mai bun',
					paragraphs: [
						'Ora de culcare constantă, lumină redusă cu o oră înainte de somn și dormitorul răcoros — cele trei obiceiuri cu cel mai bun raport efort/rezultat.',
						'Alege unul singur săptămâna aceasta. Consecvența bate perfecțiunea.'
					]
				}
			]
		},
		{
			key: 'dupa-evaluare-somn',
			name: 'După testul de somn',
			trigger: { kind: 'quiz-completed', quizSlug: 'evaluare-somn' },
			consentKey: 'newsletter',
			steps: [
				{
					offsetDays: 1,
					hourLocal: 9,
					templateKey: 'nurture',
					subject: 'Primul pas după evaluarea somnului',
					paragraphs: [
						'Ai făcut testul — acum contează ce faci cu rezultatul. Începe cu zona în care ai avut scorul cel mai mic: acolo e cel mai mult de câștigat.',
						'Pe blog găsești ghiduri scurte pentru fiecare dimensiune a somnului.'
					],
					cta: { label: 'Citește ghidurile', url: '/blog' }
				},
				{
					offsetDays: 4,
					hourLocal: 9,
					templateKey: 'nurture',
					subject: 'Cum îți construiești o rutină de seară',
					paragraphs: [
						'O rutină de seară bună are trei ingrediente: aceeași oră, aceleași gesturi, fără ecrane în ultimele 30 de minute.',
						'Repet-o 10 zile la rând și urmărește cum se schimbă cât de repede adormi.'
					]
				}
			]
		},
		{
			key: 'dupa-prima-comanda',
			name: 'După prima comandă',
			trigger: { kind: 'order-paid' },
			consentKey: 'newsletter',
			steps: [
				{
					offsetDays: 7,
					hourLocal: 10,
					templateKey: 'nurture',
					subject: 'Cum îți merge cu noua rutină?',
					paragraphs: [
						'A trecut o săptămână de la comanda ta. Schimbările de somn au nevoie de câteva săptămâni de consecvență — nu te descuraja dacă efectul nu e încă vizibil.',
						'Dacă ai întrebări despre produs, răspundem cu drag la adresa din footer.'
					]
				}
			]
		}
	]
};
