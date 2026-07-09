/**
 * Parse a positive-integer env value (timeouts, pool sizes), falling back to
 * the documented default when unset or not a positive integer. Framework-free
 * so db/module code can import it relatively.
 */
export function positiveIntEnv(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
