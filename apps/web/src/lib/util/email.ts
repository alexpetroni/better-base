/** Plausible-address check shared by CRM normalization and staff creation. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lowercased/trimmed email, or null when it is not plausibly an address. */
export function normalizeEmail(raw: string): string | null {
	const email = raw.trim().toLowerCase();
	return EMAIL_RE.test(email) ? email : null;
}
