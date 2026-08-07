/**
 * Custom-event helper with a PII firewall. Nothing in the app sends custom
 * events yet; anything that ever does MUST go through `track()`, which drops
 * personally identifying props before they reach the provider — analytics
 * payloads carry no emails, phone numbers, names or user ids, ever.
 */
const PII_KEY_PATTERN = /(email|mail|phone|telefon|name|nume|user|address|adres|ip|iban|cui)/i;
const EMAIL_VALUE_PATTERN = /\S+@\S+/;
const PHONE_VALUE_PATTERN = /^\+?[\d\s().-]{7,}$/;

export type EventProps = Record<string, string | number | boolean>;

/** Keep a prop only when neither its key nor its value looks like PII. */
export function sanitizeEventProps(props: EventProps): EventProps {
	const clean: EventProps = {};
	for (const [key, value] of Object.entries(props)) {
		if (PII_KEY_PATTERN.test(key)) continue;
		if (
			typeof value === 'string' &&
			(EMAIL_VALUE_PATTERN.test(value) || PHONE_VALUE_PATTERN.test(value.trim()))
		) {
			continue;
		}
		clean[key] = value;
	}
	return clean;
}

interface AnalyticsWindow {
	plausible?: (event: string, options?: { props?: EventProps }) => void;
	umami?: { track?: (event: string, props?: EventProps) => void };
}

/**
 * Fire a custom event on whichever provider script is loaded. A no-op when
 * none is (no consent, no-op provider, or the script is still loading) —
 * callers never need to know whether analytics is enabled.
 */
export function track(event: string, props: EventProps = {}): void {
	if (typeof window === 'undefined') return;
	const w = window as AnalyticsWindow;
	const clean = sanitizeEventProps(props);
	w.plausible?.(event, { props: clean });
	w.umami?.track?.(event, clean);
}
