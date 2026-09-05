/**
 * Optional error sink (FIX-16): when `ERROR_REPORT_URL` is set, every
 * structured error line is ALSO posted there as JSON — a webhook, a log
 * ingester, an alerting endpoint. stderr stays the primary record; the sink
 * is best-effort and must never turn one failure into two: a refusal or a
 * network error is reported on stderr as one warning line and swallowed.
 * Framework-free so the behavior is unit-testable with an injected fetch.
 */
export async function postErrorReport(
	url: string,
	line: string,
	fetchImpl: typeof fetch = fetch
): Promise<void> {
	try {
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: line
		});
		if (!response.ok) {
			console.error(
				JSON.stringify({
					ts: new Date().toISOString(),
					level: 'warn',
					message: `error report sink answered ${response.status}`
				})
			);
		}
	} catch (cause) {
		console.error(
			JSON.stringify({
				ts: new Date().toISOString(),
				level: 'warn',
				message: `error report sink unreachable: ${cause instanceof Error ? cause.message : String(cause)}`
			})
		);
	}
}
