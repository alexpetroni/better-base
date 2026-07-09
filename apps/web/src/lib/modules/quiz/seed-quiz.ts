import type { FormConfig } from 'formcomp';
import type { ScoringConfig } from './scoring.ts';

/**
 * The seeded sleep screening quiz (ro): 11 questions across 3 steps, scored
 * into 3 dimensions and 3 result bands. Content is original screening-style
 * material, not a licensed clinical instrument.
 */

const LIKERT_FREQ = [
	{ value: '0', label: 'Deloc' },
	{ value: '1', label: 'Rar' },
	{ value: '2', label: 'Des' },
	{ value: '3', label: 'Aproape zilnic' }
];

export const SLEEP_QUIZ_FORM: FormConfig = {
	version: 1,
	steps: [
		{
			id: 'noapte',
			label: 'Noaptea',
			intro: 'Gândește-te la ultimele două săptămâni.',
			groups: [
				{
					id: 'g-adormire',
					label: 'Adormirea și trezirile',
					questions: [
						{
							id: 'adormire_durata',
							uuid: 'q-adormire-durata',
							type: 'single-select',
							label: 'Cât de repede adormi de obicei?',
							required: true,
							options: [
								{ value: 'sub-15', label: 'În mai puțin de 15 minute' },
								{ value: '15-30', label: 'În 15–30 de minute' },
								{ value: '30-60', label: 'În 30–60 de minute' },
								{ value: 'peste-60', label: 'În peste o oră' }
							]
						},
						{
							id: 'treziri',
							uuid: 'q-treziri',
							type: 'single-select',
							label: 'Cât de des te trezești în timpul nopții?',
							required: true,
							options: [
								{ value: 'rar', label: 'Rar sau deloc' },
								{ value: 'uneori', label: 'Uneori, dar readorm ușor' },
								{ value: 'des', label: 'Des, readorm greu' },
								{ value: 'foarte-des', label: 'Aproape în fiecare noapte' }
							]
						},
						{
							id: 'trezire_devreme',
							uuid: 'q-trezire-devreme',
							type: 'single-select',
							label: 'Te trezești dimineața mai devreme decât ai vrea, fără să mai poți adormi?',
							required: true,
							options: [
								{ value: 'niciodata', label: 'Aproape niciodată' },
								{ value: 'uneori', label: 'Uneori' },
								{ value: 'des', label: 'Des' }
							]
						}
					]
				},
				{
					id: 'g-durata',
					label: 'Durata somnului',
					questions: [
						{
							id: 'ore_somn',
							uuid: 'q-ore-somn',
							type: 'single-select',
							label: 'Câte ore dormi în medie pe noapte?',
							required: true,
							options: [
								{ value: '7-9', label: '7–9 ore' },
								{ value: 'peste-9', label: 'Peste 9 ore' },
								{ value: '6-7', label: '6–7 ore' },
								{ value: '5-6', label: '5–6 ore' },
								{ value: 'sub-5', label: 'Sub 5 ore' }
							]
						}
					]
				}
			]
		},
		{
			id: 'zi',
			label: 'Ziua',
			groups: [
				{
					id: 'g-zi',
					label: 'Cât de des ți s-a întâmplat, în ultimele două săptămâni?',
					renderMode: 'likert-batch',
					questions: [
						{
							id: 'oboseala_zi',
							uuid: 'q-oboseala-zi',
							type: 'likert',
							label: 'M-am simțit obosit(ă) în timpul zilei',
							required: true,
							options: LIKERT_FREQ
						},
						{
							id: 'concentrare',
							uuid: 'q-concentrare',
							type: 'likert',
							label: 'Mi-a fost greu să mă concentrez',
							required: true,
							options: LIKERT_FREQ
						},
						{
							id: 'atipiri',
							uuid: 'q-atipiri',
							type: 'likert',
							label: 'Am ațipit neintenționat (la birou, la TV)',
							required: true,
							options: LIKERT_FREQ
						}
					]
				},
				{
					id: 'g-impact',
					label: 'Impactul asupra ta',
					questions: [
						{
							id: 'impact',
							uuid: 'q-impact',
							type: 'single-select',
							label: 'Cât de mult îți afectează somnul calitatea vieții?',
							required: true,
							options: [
								{ value: 'deloc', label: 'Deloc' },
								{ value: 'putin', label: 'Puțin' },
								{ value: 'moderat', label: 'Moderat' },
								{ value: 'mult', label: 'Mult' }
							]
						}
					]
				}
			]
		},
		{
			id: 'obiceiuri',
			label: 'Obiceiuri',
			groups: [
				{
					id: 'g-obiceiuri',
					label: 'Igiena somnului',
					questions: [
						{
							id: 'cafeina',
							uuid: 'q-cafeina',
							type: 'single-select',
							label: 'Consumi cafea, energizante sau alte surse de cafeină după ora 16:00?',
							required: true,
							options: [
								{ value: 'niciodata', label: 'Aproape niciodată' },
								{ value: 'uneori', label: 'Uneori' },
								{ value: 'zilnic', label: 'Zilnic' }
							]
						},
						{
							id: 'ecrane',
							uuid: 'q-ecrane',
							type: 'single-select',
							label: 'Folosești telefonul sau alte ecrane în pat, înainte de culcare?',
							required: true,
							options: [
								{ value: 'rar', label: 'Rar' },
								{ value: 'uneori', label: 'Uneori' },
								{ value: 'seara-de-seara', label: 'Seară de seară' }
							]
						},
						{
							id: 'factori',
							uuid: 'q-factori',
							type: 'multi-select',
							label: 'Care dintre următoarele ți se potrivesc?',
							required: true,
							options: [
								{
									value: 'program-neregulat',
									label: 'Ore de culcare foarte diferite de la o zi la alta'
								},
								{ value: 'alcool-seara', label: 'Alcool seara, de mai multe ori pe săptămână' },
								{
									value: 'sport-tarziu',
									label: 'Sport intens cu mai puțin de 2 ore înainte de culcare'
								},
								{ value: 'dormitor-zgomotos', label: 'Dormitor zgomotos sau prea luminos' },
								{ value: 'niciuna', label: 'Niciuna dintre acestea', exclusive: true }
							]
						}
					]
				}
			]
		}
	]
};

export const SLEEP_QUIZ_SCORING: ScoringConfig = {
	questions: {
		adormire_durata: {
			kind: 'map',
			dimension: 'noapte',
			map: { 'sub-15': 0, '15-30': 1, '30-60': 2, 'peste-60': 3 }
		},
		treziri: {
			kind: 'map',
			dimension: 'noapte',
			map: { rar: 0, uneori: 1, des: 2, 'foarte-des': 3 }
		},
		trezire_devreme: {
			kind: 'map',
			dimension: 'noapte',
			map: { niciodata: 0, uneori: 1, des: 2 }
		},
		ore_somn: {
			kind: 'map',
			dimension: 'noapte',
			map: { '7-9': 0, 'peste-9': 1, '6-7': 1, '5-6': 2, 'sub-5': 3 }
		},
		oboseala_zi: { kind: 'map', dimension: 'zi', map: { '0': 0, '1': 1, '2': 2, '3': 3 } },
		concentrare: { kind: 'map', dimension: 'zi', map: { '0': 0, '1': 1, '2': 2, '3': 3 } },
		atipiri: { kind: 'map', dimension: 'zi', map: { '0': 0, '1': 1, '2': 2, '3': 3 } },
		impact: { kind: 'map', dimension: 'zi', map: { deloc: 0, putin: 1, moderat: 2, mult: 3 } },
		cafeina: { kind: 'map', dimension: 'obiceiuri', map: { niciodata: 0, uneori: 1, zilnic: 2 } },
		ecrane: {
			kind: 'map',
			dimension: 'obiceiuri',
			map: { rar: 0, uneori: 1, 'seara-de-seara': 2 }
		},
		factori: {
			kind: 'map',
			dimension: 'obiceiuri',
			map: {
				'program-neregulat': 2,
				'alcool-seara': 1,
				'sport-tarziu': 1,
				'dormitor-zgomotos': 1,
				niciuna: 0
			}
		}
	},
	dimensions: {
		noapte: { label: 'Somnul nocturn' },
		zi: { label: 'Impactul din timpul zilei' },
		obiceiuri: { label: 'Igiena somnului' }
	},
	bands: [
		{
			key: 'bun',
			min: 0,
			label: 'Somn în formă bună',
			advice:
				'Somnul tău pare solid. Păstrează orele constante de culcare și trezire și obiceiurile care funcționează deja pentru tine.'
		},
		{
			key: 'atentie',
			min: 9,
			label: 'Semne de atenție',
			advice:
				'Somnul tău dă semne de uzură. Începe cu igiena somnului: oră fixă de culcare, fără cafeină după-amiaza și fără ecrane în pat — schimbările mici, ținute două săptămâni, se văd.'
		},
		{
			key: 'risc',
			min: 19,
			label: 'Somn afectat serios',
			advice:
				'Răspunsurile tale indică probleme de somn semnificative, cu impact asupra zilei. Pe lângă igiena somnului, ia în calcul o discuție cu medicul de familie sau un specialist în somnologie.'
		}
	]
};

export const SLEEP_QUIZ_SEED = {
	id: 'seed-quiz-evaluare-somn',
	slug: 'evaluare-somn',
	title: 'Evaluarea somnului',
	introMd:
		'Un test de **3 minute** despre cum adormi, cum te simți ziua și ce obiceiuri îți influențează nopțile.\n\nPrimești pe loc un scor, o încadrare și recomandări practice — iar dacă vrei, ți le trimitem și pe email.',
	pillarSlug: 'somn',
	resultTemplateKey: 'quiz-result',
	formSchema: SLEEP_QUIZ_FORM,
	scoring: SLEEP_QUIZ_SCORING
} as const;
