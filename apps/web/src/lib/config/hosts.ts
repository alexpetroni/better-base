/**
 * Local-service hostname normalization.
 *
 * The compose stack (Postgres, MinIO, imgproxy) publishes its ports on the
 * DOCKER HOST. How you reach them therefore depends on where the process
 * runs, and one committed `.env` cannot be right for both:
 *   - on the host        → `localhost`
 *   - in a sibling container (an agent/phase runner) → `host.docker.internal`
 *
 * Getting this wrong is the classic local failure: `ENOTFOUND
 * host.docker.internal` from vitest/scripts on the host, or `ECONNREFUSED
 * localhost` from inside a container. So instead of asking everyone to edit
 * `.env`, tooling rewrites these variables at load time to whichever spelling
 * suits the current process.
 *
 * Pure and dependency-free on purpose (no node imports): the caller detects
 * containerhood and passes it in, which also makes both directions testable.
 */

/** The docker-host alias containers use to reach ports published on the host. */
export const CONTAINER_HOST_ALIAS = 'host.docker.internal';

/** Variables holding a URL to a compose service. Others are never touched. */
export const SERVICE_URL_VARS = [
	'DATABASE_URL',
	'TEST_DATABASE_URL',
	'S3_ENDPOINT',
	'IMGPROXY_URL'
] as const;

/**
 * Hostnames that mean "the docker host" and may be rewritten. Anything else —
 * a compose service name (`db`, `minio`), a staging/production host — is left
 * alone, so this can never touch a real deployment's configuration.
 */
const REWRITABLE = new Set(['localhost', '127.0.0.1', CONTAINER_HOST_ALIAS]);

/**
 * Rewrite the compose-service hostnames in `env` in place for the current
 * process location. Returns the names of the variables that changed.
 *
 * Only the host substring is spliced — port, credentials, database name, path
 * and trailing-slash style all survive byte for byte. (Round-tripping through
 * `new URL()` would not: it appends a `/` to `http://localhost:8888`, and
 * `${IMGPROXY_URL}/sig/…` then builds a double slash imgproxy 404s on.)
 *
 * `PUBLIC_SITE_URL`/`ORIGIN` are deliberately NOT in scope — they describe the
 * app's own origin, not a service it dials.
 */
export function normalizeServiceHosts(
	env: Record<string, string | undefined>,
	inContainer: boolean
): string[] {
	const target = inContainer ? CONTAINER_HOST_ALIAS : 'localhost';
	const changed: string[] = [];

	for (const name of SERVICE_URL_VARS) {
		const value = env[name];
		if (!value) continue;

		const schemeEnd = value.indexOf('://');
		if (schemeEnd < 0) continue; // not a URL we understand — leave it as written
		const authStart = schemeEnd + 3;
		const slash = value.indexOf('/', authStart);
		const authEnd = slash < 0 ? value.length : slash;
		// Credentials may contain '@' and ':' — the host starts after the LAST '@'.
		const hostStart = authStart + value.slice(authStart, authEnd).lastIndexOf('@') + 1;
		const host = value.slice(hostStart, authEnd).split(':')[0];

		if (!REWRITABLE.has(host) || host === target) continue;
		env[name] = value.slice(0, hostStart) + target + value.slice(hostStart + host.length);
		changed.push(name);
	}
	return changed;
}
