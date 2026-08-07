import { describe, expect, it } from 'vitest';
import { validateSequenceDefinition, type NurtureSequenceDefinition } from './definition.ts';
import { computeStepScheduledAt, retryDelayMs } from './schedule.ts';

// Pure schedule math. The DST cases are the point: Europe/Bucharest springs
// forward on 2026-03-29 (EET +02 → EEST +03) and falls back on 2026-10-25 —
// naive `+ offsetDays × 24h` math sends at the wrong local hour twice a year.

const HOUR = 60 * 60 * 1000;

describe('computeStepScheduledAt', () => {
	it('without hourLocal: exactly offsetDays × 24h after enrollment', () => {
		const enrolledAt = new Date('2026-02-10T14:30:00Z');
		expect(computeStepScheduledAt(enrolledAt, { offsetDays: 0 })).toEqual(enrolledAt);
		expect(computeStepScheduledAt(enrolledAt, { offsetDays: 3 })).toEqual(
			new Date('2026-02-13T14:30:00Z')
		);
	});

	it('with hourLocal: at the Bucharest wall-clock hour on the target day (winter, +02)', () => {
		// Enrolled 2026-02-10 12:00 Bucharest (10:00Z); day+2 at 09:00 local = 07:00Z.
		const due = computeStepScheduledAt(new Date('2026-02-10T10:00:00Z'), {
			offsetDays: 2,
			hourLocal: 9
		});
		expect(due).toEqual(new Date('2026-02-12T07:00:00.000Z'));
	});

	it('crossing the spring-forward transition keeps the local hour (naive math is 1h late)', () => {
		// Enrolled Fri 2026-03-27 10:00 EET (+02). Three days later is Mon
		// 2026-03-30 — after the Mar 29 spring-forward, so 09:00 EEST = 06:00Z.
		const due = computeStepScheduledAt(new Date('2026-03-27T08:00:00Z'), {
			offsetDays: 3,
			hourLocal: 9
		});
		expect(due).toEqual(new Date('2026-03-30T06:00:00.000Z'));
		// The broken version: enrollment UTC + 72h lands at 08:00Z = 11:00 EEST.
		expect(due.getTime()).not.toBe(new Date('2026-03-27T08:00:00Z').getTime() + 3 * 24 * HOUR);
	});

	it('crossing the fall-back transition keeps the local hour too', () => {
		// Enrolled Fri 2026-10-23 08:00 EEST (+03); Mon 2026-10-26 is after the
		// Oct 25 fall-back, so 09:00 EET = 07:00Z.
		const due = computeStepScheduledAt(new Date('2026-10-23T05:00:00Z'), {
			offsetDays: 3,
			hourLocal: 9
		});
		expect(due).toEqual(new Date('2026-10-26T07:00:00.000Z'));
	});

	it('uses the Bucharest calendar day, not the UTC one, to anchor offsets', () => {
		// 22:30Z on Feb 10 is already Feb 11 00:30 in Bucharest — "next day at
		// 9" must mean Feb 12, not Feb 11.
		const due = computeStepScheduledAt(new Date('2026-02-10T22:30:00Z'), {
			offsetDays: 1,
			hourLocal: 9
		});
		expect(due).toEqual(new Date('2026-02-12T07:00:00.000Z'));
	});

	it('never schedules into the past: an already-passed hour clamps to the enrollment instant', () => {
		// Enrolled 20:00 local; a day-0 step at 09:00 local would be 11h ago.
		const enrolledAt = new Date('2026-02-10T18:00:00Z');
		expect(computeStepScheduledAt(enrolledAt, { offsetDays: 0, hourLocal: 9 })).toEqual(enrolledAt);
	});
});

describe('retryDelayMs', () => {
	it('backs off exponentially: 15m, 1h, 4h, 16h', () => {
		expect(retryDelayMs(1)).toBe(15 * 60 * 1000);
		expect(retryDelayMs(2)).toBe(60 * 60 * 1000);
		expect(retryDelayMs(3)).toBe(4 * 60 * 60 * 1000);
		expect(retryDelayMs(4)).toBe(16 * 60 * 60 * 1000);
	});
});

describe('validateSequenceDefinition', () => {
	const valid: NurtureSequenceDefinition = {
		key: 'welcome',
		name: 'Welcome',
		trigger: { kind: 'consent-confirmed' },
		consentKey: 'newsletter',
		steps: [{ offsetDays: 0, templateKey: 'nurture', subject: 'Salut', paragraphs: ['Bun venit.'] }]
	};

	it('accepts a valid definition', () => {
		expect(validateSequenceDefinition(valid)).toEqual([]);
	});

	it('rejects empty steps, bad offsets, bad hours and unknown template keys', () => {
		expect(validateSequenceDefinition({ ...valid, steps: [] })).not.toEqual([]);
		expect(
			validateSequenceDefinition({
				...valid,
				steps: [{ ...valid.steps[0], offsetDays: -1 }]
			})
		).not.toEqual([]);
		expect(
			validateSequenceDefinition({
				...valid,
				steps: [{ ...valid.steps[0], hourLocal: 24 }]
			})
		).not.toEqual([]);
		expect(
			validateSequenceDefinition({
				...valid,
				steps: [{ ...valid.steps[0], templateKey: 'quiz-result' as 'nurture' }]
			})
		).not.toEqual([]);
	});

	it('requires a quizSlug on quiz-completed triggers', () => {
		expect(
			validateSequenceDefinition({
				...valid,
				trigger: { kind: 'quiz-completed', quizSlug: ' ' }
			})
		).not.toEqual([]);
	});
});
