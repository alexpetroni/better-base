import { describe, expect, it } from 'vitest';
import { CONTAINER_HOST_ALIAS, normalizeServiceHosts } from './hosts.ts';

const CONTAINER_ENV = {
	DATABASE_URL: `postgres://better:better@${CONTAINER_HOST_ALIAS}:5433/better_sleep`,
	TEST_DATABASE_URL: `postgres://better:better@${CONTAINER_HOST_ALIAS}:5433/better_test`,
	S3_ENDPOINT: `http://${CONTAINER_HOST_ALIAS}:9000`,
	IMGPROXY_URL: `http://${CONTAINER_HOST_ALIAS}:8888`
};

const HOST_ENV = {
	DATABASE_URL: 'postgres://better:better@localhost:5433/better_sleep',
	TEST_DATABASE_URL: 'postgres://better:better@localhost:5433/better_test',
	S3_ENDPOINT: 'http://localhost:9000',
	IMGPROXY_URL: 'http://localhost:8888'
};

describe('normalizeServiceHosts', () => {
	it('rewrites the container alias to localhost when running on the host', () => {
		const env = { ...CONTAINER_ENV };
		const changed = normalizeServiceHosts(env, false);

		expect(env).toEqual(HOST_ENV);
		expect(changed.sort()).toEqual([
			'DATABASE_URL',
			'IMGPROXY_URL',
			'S3_ENDPOINT',
			'TEST_DATABASE_URL'
		]);
	});

	it('rewrites localhost to the container alias when running in a container', () => {
		const env = { ...HOST_ENV };
		normalizeServiceHosts(env, true);
		expect(env).toEqual(CONTAINER_ENV);
	});

	it('rewrites 127.0.0.1 too', () => {
		const env = { S3_ENDPOINT: 'http://127.0.0.1:9000' };
		normalizeServiceHosts(env, true);
		expect(env.S3_ENDPOINT).toBe(`http://${CONTAINER_HOST_ALIAS}:9000`);
	});

	it('reports no change when the env already matches', () => {
		const env = { ...HOST_ENV };
		expect(normalizeServiceHosts(env, false)).toEqual([]);
		expect(env).toEqual(HOST_ENV);
	});

	it('preserves port, credentials, database and trailing-slash style', () => {
		// A '@' and ':' inside the password must not confuse host detection, and
		// no slash may be appended — `${IMGPROXY_URL}/sig/…` would 404 on `//`.
		const env = {
			DATABASE_URL: `postgres://user:p@ss:word@${CONTAINER_HOST_ALIAS}:5433/db?sslmode=disable`,
			IMGPROXY_URL: `http://${CONTAINER_HOST_ALIAS}:8888`
		};
		normalizeServiceHosts(env, false);

		expect(env.DATABASE_URL).toBe('postgres://user:p@ss:word@localhost:5433/db?sslmode=disable');
		expect(env.IMGPROXY_URL).toBe('http://localhost:8888');
	});

	it('leaves non-local hostnames alone', () => {
		// Compose-internal service names and real deployments must never move.
		const env = {
			DATABASE_URL: 'postgres://u:p@db:5432/better',
			S3_ENDPOINT: 'http://minio:9000',
			IMGPROXY_URL: 'https://img.bettersleep.ro'
		};
		expect(normalizeServiceHosts(env, false)).toEqual([]);
		expect(env).toEqual({
			DATABASE_URL: 'postgres://u:p@db:5432/better',
			S3_ENDPOINT: 'http://minio:9000',
			IMGPROXY_URL: 'https://img.bettersleep.ro'
		});
	});

	it('ignores variables outside the service list', () => {
		// The app's own origin is not a service it dials — it must stay localhost
		// even in a container, where the browser is the one loading it.
		const env = { PUBLIC_SITE_URL: 'http://localhost:5173', ORIGIN: 'http://localhost:5173' };
		expect(normalizeServiceHosts(env, true)).toEqual([]);
		expect(env.PUBLIC_SITE_URL).toBe('http://localhost:5173');
	});

	it('rewrites the scheme-less NEON_WS_PROXY host:port both ways', () => {
		// The neon driver's wsProxy option takes `host:port` without a scheme —
		// the ws:// prefix is the driver's own choice (db/client.ts).
		const env = { NEON_WS_PROXY: 'localhost:5488' };
		expect(normalizeServiceHosts(env, true)).toEqual(['NEON_WS_PROXY']);
		expect(env.NEON_WS_PROXY).toBe(`${CONTAINER_HOST_ALIAS}:5488`);
		normalizeServiceHosts(env, false);
		expect(env.NEON_WS_PROXY).toBe('localhost:5488');
	});

	it('leaves a non-local NEON_WS_PROXY alone', () => {
		const env = { NEON_WS_PROXY: 'neon-proxy:80' };
		expect(normalizeServiceHosts(env, true)).toEqual([]);
		expect(env.NEON_WS_PROXY).toBe('neon-proxy:80');
	});

	it('skips missing and unparseable values', () => {
		const env = { DATABASE_URL: undefined, S3_ENDPOINT: 'not-a-url' };
		expect(normalizeServiceHosts(env, false)).toEqual([]);
		expect(env.S3_ENDPOINT).toBe('not-a-url');
	});
});
