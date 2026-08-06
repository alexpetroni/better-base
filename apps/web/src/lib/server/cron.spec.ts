import { describe, expect, it } from 'vitest';
import { authorizeCron } from './cron.ts';

const SECRET = 'cron-secret-value';

describe('authorizeCron', () => {
	it('accepts the matching bearer token', () => {
		expect(authorizeCron(`Bearer ${SECRET}`, SECRET)).toEqual({ ok: true });
	});

	it('rejects a wrong token with 401', () => {
		expect(authorizeCron('Bearer nope', SECRET)).toMatchObject({ ok: false, status: 401 });
	});

	it('rejects a same-length wrong token', () => {
		const wrong = 'x'.repeat(SECRET.length);
		expect(authorizeCron(`Bearer ${wrong}`, SECRET)).toMatchObject({ ok: false, status: 401 });
	});

	it('rejects a missing or malformed header', () => {
		expect(authorizeCron(null, SECRET)).toMatchObject({ ok: false, status: 401 });
		expect(authorizeCron(SECRET, SECRET)).toMatchObject({ ok: false, status: 401 });
		expect(authorizeCron(`Basic ${SECRET}`, SECRET)).toMatchObject({ ok: false, status: 401 });
	});

	it('reports an unconfigured secret as 503 and never falls open', () => {
		// The dangerous case: an empty expected secret must not match an empty
		// bearer token, or an unconfigured deploy would run the job for anyone.
		expect(authorizeCron('Bearer ', undefined)).toMatchObject({ ok: false, status: 503 });
		expect(authorizeCron('Bearer ', '')).toMatchObject({ ok: false, status: 503 });
		expect(authorizeCron(null, '')).toMatchObject({ ok: false, status: 503 });
	});
});
