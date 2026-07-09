/**
 * Display dates. One formatter per style, always `ro-RO` and pinned to
 * Europe/Bucharest — SSR (often UTC) and the visitor's browser must render
 * the SAME string or hydration flags a mismatch near midnight.
 */

const STYLES = {
	/** Admin lists: `16 ian. 2026`. */
	medium: { dateStyle: 'medium' },
	/** Public article dates: `16 ianuarie 2026`. */
	long: { dateStyle: 'long' },
	/** Admin lists with time: `16 ian. 2026, 00:30`. */
	'medium-time': { dateStyle: 'medium', timeStyle: 'short' },
	/** Order detail: `16 ianuarie 2026 la 00:30`. */
	'long-time': { dateStyle: 'long', timeStyle: 'short' }
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

export type DateStyle = keyof typeof STYLES;

const formatters = new Map<DateStyle, Intl.DateTimeFormat>();

export function formatDate(date: Date, style: DateStyle = 'medium'): string {
	let fmt = formatters.get(style);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat('ro-RO', { ...STYLES[style], timeZone: 'Europe/Bucharest' });
		formatters.set(style, fmt);
	}
	return fmt.format(date);
}
