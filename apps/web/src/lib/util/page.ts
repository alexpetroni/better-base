/**
 * `?page=` from a query string → a usable 1-based page number. Anything that
 * is not a safe positive integer (`1.5`, `abc`, `-3`, `1e400`) is page 1 —
 * a fractional page used to reach the database as a fractional OFFSET and
 * 500 (FIX-15). Whether the page exists is the caller's check (404 past the
 * end, against the list's `pageCount`).
 */
export function parsePageParam(raw: string | null): number {
	if (raw === null || raw.trim() === '') return 1;
	const n = Number(raw);
	return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

/** True when `page` is beyond the last page (page 1 always exists, even empty). */
export function pastLastPage(page: number, pageCount: number): boolean {
	return page > Math.max(1, pageCount);
}
