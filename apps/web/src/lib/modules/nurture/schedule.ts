import type { SequenceStep } from './definition.ts';

/**
 * Schedule math, pure. Steps are day-granular with an optional local send
 * hour; the queue's drift bound (one cron interval, see README) makes
 * anything finer meaningless.
 */

/** Sends claimed per cron invocation (serverless time-limit bound). */
export const NURTURE_SEND_BATCH = 25;
/** After this many failed attempts a send parks as `failed` for the operator. */
export const NURTURE_MAX_ATTEMPTS = 5;
/** A `sending` claim older than this is considered crashed and re-claimable. */
export const NURTURE_STALE_CLAIM_MINUTES = 15;

export const NURTURE_TIMEZONE = 'Europe/Bucharest';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** Wall-clock date/time parts of an instant in a timezone (Intl, no deps). */
function wallClockParts(instant: Date, timeZone: string) {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23'
	});
	const parts: Record<string, number> = {};
	for (const part of fmt.formatToParts(instant)) {
		if (part.type !== 'literal') parts[part.type] = Number(part.value);
	}
	return parts as {
		year: number;
		month: number;
		day: number;
		hour: number;
		minute: number;
		second: number;
	};
}

/** UTC offset of `timeZone` at `instant`, in ms (Bucharest: +2h EET / +3h EEST). */
function tzOffsetMs(instant: Date, timeZone: string): number {
	const p = wallClockParts(instant, timeZone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

/**
 * When a step is due, given the enrollment instant. With `hourLocal`: at that
 * wall-clock hour in `timeZone` on the enrollment's local calendar day plus
 * `offsetDays` — resolved through the timezone offset AT THE TARGET DAY, so a
 * DST transition between enrollment and step moves the UTC instant, not the
 * subscriber-visible hour (naive `+ offsetDays × 24h` gets this wrong twice a
 * year). Without `hourLocal`: exactly `offsetDays × 24h` later. A result not
 * after the enrollment instant clamps to it (never schedule into the past).
 */
export function computeStepScheduledAt(
	enrolledAt: Date,
	step: Pick<SequenceStep, 'offsetDays' | 'hourLocal'>,
	timeZone: string = NURTURE_TIMEZONE
): Date {
	if (step.hourLocal === undefined) {
		return new Date(enrolledAt.getTime() + step.offsetDays * DAY_MS);
	}
	const local = wallClockParts(enrolledAt, timeZone);
	// Target wall-clock time, read as if it were UTC…
	const wallUtc = Date.UTC(
		local.year,
		local.month - 1,
		local.day + step.offsetDays,
		step.hourLocal
	);
	// …then shifted by the zone offset. Two passes: the first guess may sit on
	// the wrong side of a DST transition; re-reading the offset at the guessed
	// instant converges (offsets change at most once per day).
	let instant = wallUtc - tzOffsetMs(new Date(wallUtc), timeZone);
	instant = wallUtc - tzOffsetMs(new Date(instant), timeZone);
	return instant > enrolledAt.getTime() ? new Date(instant) : new Date(enrolledAt.getTime());
}

/**
 * Backoff before retry `attempts + 1`, from the attempt count AFTER the failed
 * one: 15min, 1h, 4h, 16h. Exponential so a broken provider is not hammered,
 * capped by NURTURE_MAX_ATTEMPTS parking the send.
 */
export function retryDelayMs(attempts: number): number {
	return 15 * MINUTE_MS * 4 ** (Math.max(attempts, 1) - 1);
}

/**
 * Pause between two consecutive LIVE sends inside one drain batch: Resend
 * allows ~2 requests/s, and a 25-row batch fired back-to-back would trip its
 * 429s (audit 2026-09-03 P1). 25 × 0.5 s stays well inside the 60 s cron
 * function budget. Dry runs touch no API and are not paced.
 */
export const NURTURE_SEND_PACE_MS = 500;
