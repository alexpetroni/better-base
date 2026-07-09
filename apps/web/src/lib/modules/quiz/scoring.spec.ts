import { describe, expect, it } from 'vitest';
import type { FormConfig } from 'formcomp';
import {
	answersFromSubmitAnswers,
	flattenStepResponses,
	pickBand,
	scoreQuiz,
	validateScoringConfig,
	type ScoringBand,
	type ScoringConfig
} from './scoring.ts';

// A small two-step schema exercising every scored question kind.
const FORM: FormConfig = {
	steps: [
		{
			id: 'noapte',
			label: 'Noaptea',
			groups: [
				{
					id: 'g1',
					label: 'Adormire',
					questions: [
						{
							id: 'adormire',
							type: 'single-select',
							label: 'Cât durează să adormi?',
							options: [
								{ value: 'sub-15', label: 'Sub 15 minute' },
								{ value: '15-30', label: '15–30 minute' },
								{ value: 'peste-30', label: 'Peste 30 de minute' }
							]
						},
						{
							id: 'factori',
							type: 'multi-select',
							label: 'Ce te ține treaz?',
							options: [
								{ value: 'ganduri', label: 'Gânduri' },
								{ value: 'zgomot', label: 'Zgomot' },
								{ value: 'nimic', label: 'Nimic', exclusive: true }
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
					id: 'g2',
					label: 'Impact',
					questions: [
						{ id: 'oboseala', type: 'scale', label: 'Oboseală', min: 1, max: 5 },
						{ id: 'cafele', type: 'number-input', label: 'Cafele pe zi', min: 0 }
					]
				}
			]
		}
	]
};

const BANDS: ScoringBand[] = [
	{ key: 'bun', min: 0, label: 'Somn bun', advice: 'Continuă așa.' },
	{ key: 'atentie', min: 5, label: 'Semne de atenție', advice: 'Corectează obiceiurile.' },
	{ key: 'risc', min: 10, label: 'Risc ridicat', advice: 'Vorbește cu un specialist.' }
];

const SCORING: ScoringConfig = {
	questions: {
		adormire: {
			kind: 'map',
			dimension: 'adormire',
			map: { 'sub-15': 0, '15-30': 2, 'peste-30': 4 }
		},
		factori: { kind: 'map', dimension: 'adormire', map: { ganduri: 2, zgomot: 1, nimic: 0 } },
		oboseala: { kind: 'numeric', dimension: 'zi' },
		cafele: { kind: 'numeric', dimension: 'zi', multiplier: 2, cap: 6 }
	},
	dimensions: {
		adormire: { label: 'Adormire' },
		zi: { label: 'Impact în timpul zilei' }
	},
	bands: BANDS
};

describe('pickBand', () => {
	const bands = BANDS;

	it('a score exactly on a threshold belongs to the higher band', () => {
		expect(pickBand(bands, 5).key).toBe('atentie');
		expect(pickBand(bands, 10).key).toBe('risc');
	});

	it('scores between thresholds fall in the lower band', () => {
		expect(pickBand(bands, 0).key).toBe('bun');
		expect(pickBand(bands, 4).key).toBe('bun');
		expect(pickBand(bands, 9).key).toBe('atentie');
		expect(pickBand(bands, 40).key).toBe('risc');
	});

	it('a score below every threshold falls into the first band', () => {
		expect(pickBand(bands, -3).key).toBe('bun');
	});

	it('throws on an empty band list', () => {
		expect(() => pickBand([], 1)).toThrow();
	});
});

describe('scoreQuiz', () => {
	it('sums per-answer points across map, multi-select and numeric questions', () => {
		const profile = scoreQuiz(FORM, SCORING, {
			adormire: 'peste-30', // 4
			factori: ['ganduri', 'zgomot'], // 2 + 1
			oboseala: 3, // 3
			cafele: 2 // 2 * 2
		});
		expect(profile.score).toBe(14);
		expect(profile.band.key).toBe('risc');
	});

	it('missing answers score 0 and still produce a band', () => {
		const profile = scoreQuiz(FORM, SCORING, {});
		expect(profile.score).toBe(0);
		expect(profile.band.key).toBe('bun');
		expect(profile.band.label).toBe('Somn bun');
	});

	it('unknown option values and non-numeric answers score 0', () => {
		const profile = scoreQuiz(FORM, SCORING, {
			adormire: 'inexistent',
			factori: ['altceva'],
			oboseala: 'multa',
			cafele: Number.NaN
		});
		expect(profile.score).toBe(0);
	});

	it('clamps numeric answers to the question min/max and applies cap', () => {
		const profile = scoreQuiz(FORM, SCORING, {
			oboseala: 99, // clamped to max 5
			cafele: 100 // 100*2 capped at 6
		});
		expect(profile.score).toBe(5 + 6);
	});

	it('negative numeric answers clamp to the question min', () => {
		const profile = scoreQuiz(FORM, SCORING, { cafele: -4 });
		expect(profile.score).toBe(0);
	});

	it('breaks the score down per dimension with ro labels', () => {
		const profile = scoreQuiz(FORM, SCORING, {
			adormire: '15-30',
			factori: ['ganduri'],
			oboseala: 2,
			cafele: 1
		});
		const adormire = profile.dimensions.find((d) => d.key === 'adormire');
		const zi = profile.dimensions.find((d) => d.key === 'zi');
		expect(adormire).toMatchObject({ label: 'Adormire', score: 4 });
		expect(zi).toMatchObject({ label: 'Impact în timpul zilei', score: 4 });
	});

	it('computes the maximum reachable score overall and per dimension', () => {
		const profile = scoreQuiz(FORM, SCORING, {});
		// adormire: max 4; factori: 2+1 (exclusive "nimic" scores 0); oboseala: 5; cafele: cap 6
		expect(profile.maxScore).toBe(4 + 3 + 5 + 6);
		expect(profile.dimensions.find((d) => d.key === 'adormire')?.maxScore).toBe(7);
		expect(profile.dimensions.find((d) => d.key === 'zi')?.maxScore).toBe(11);
	});

	it('reports a null maxScore when a numeric question is unbounded', () => {
		const scoring: ScoringConfig = {
			questions: { cafele: { kind: 'numeric' } }, // no question.max, no cap
			bands: BANDS
		};
		const profile = scoreQuiz(FORM, scoring, { cafele: 3 });
		expect(profile.score).toBe(3);
		expect(profile.maxScore).toBeNull();
	});
});

describe('answer flattening', () => {
	it('flattens formcomp step responses to a questionId map', () => {
		expect(flattenStepResponses({ noapte: { adormire: 'sub-15' }, zi: { oboseala: 2 } })).toEqual({
			adormire: 'sub-15',
			oboseala: 2
		});
	});

	it('maps a formcomp submit payload answers array by questionId', () => {
		expect(
			answersFromSubmitAnswers([
				{ questionId: 'adormire', value: 'sub-15' },
				{ questionId: 'oboseala', value: 4 }
			])
		).toEqual({ adormire: 'sub-15', oboseala: 4 });
	});
});

describe('validateScoringConfig', () => {
	it('accepts the reference scoring config', () => {
		expect(validateScoringConfig(FORM, SCORING)).toEqual([]);
	});

	it('rejects non-object input and missing pieces', () => {
		expect(validateScoringConfig(FORM, null).length).toBeGreaterThan(0);
		expect(validateScoringConfig(FORM, { questions: {} }).length).toBeGreaterThan(0);
		expect(validateScoringConfig(FORM, { bands: BANDS }).length).toBeGreaterThan(0);
	});

	it('rejects empty or non-increasing bands', () => {
		expect(validateScoringConfig(FORM, { questions: {}, bands: [] }).join(' ')).toContain('band');
		const unordered = {
			questions: {},
			bands: [
				{ key: 'a', min: 5, label: 'A', advice: 'a' },
				{ key: 'b', min: 5, label: 'B', advice: 'b' }
			]
		};
		expect(validateScoringConfig(FORM, unordered).join(' ')).toContain('crescătoare');
	});

	it('rejects scored questions that do not exist in the form schema', () => {
		const scoring = { questions: { fantoma: { kind: 'map', map: { a: 1 } } }, bands: BANDS };
		expect(validateScoringConfig(FORM, scoring).join(' ')).toContain('fantoma');
	});

	it('rejects map keys that are not options of the question', () => {
		const scoring = {
			questions: { adormire: { kind: 'map', map: { 'nu-exista': 3 } } },
			bands: BANDS
		};
		expect(validateScoringConfig(FORM, scoring).join(' ')).toContain('nu-exista');
	});

	it('rejects references to undeclared dimensions', () => {
		const scoring = {
			questions: { oboseala: { kind: 'numeric', dimension: 'necunoscut' } },
			bands: BANDS
		};
		expect(validateScoringConfig(FORM, scoring).join(' ')).toContain('necunoscut');
	});
});
