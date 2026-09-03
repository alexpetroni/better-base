import { describe, expect, it } from 'vitest';
import {
	applySecurityHeaders,
	originOf,
	runtimeCspDirectives,
	type SecurityHeadersEnv
} from './security-headers.ts';

const PROD_ENV: SecurityHeadersEnv = {
	PUBLIC_SITE_URL: 'https://bettersleep.ro',
	MEDIA_PUBLIC_BASE_URL: 'https://media.bettersleep.ro',
	S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com',
	S3_BUCKET: 'better-sleep-media',
	PUBLIC_ANALYTICS_HOST: 'https://plausible.io'
};

describe('originOf', () => {
	it('extracts origins and refuses garbage', () => {
		expect(originOf('https://media.x.ro/some/path')).toBe('https://media.x.ro');
		expect(originOf('http://localhost:9000')).toBe('http://localhost:9000');
		expect(originOf('')).toBeNull();
		expect(originOf(undefined)).toBeNull();
		expect(originOf('not a url')).toBeNull();
	});
});

describe('runtimeCspDirectives', () => {
	it('builds img-src from the media origin plus data: (blurhash placeholders)', () => {
		const csp = runtimeCspDirectives(PROD_ENV, { isAdmin: false });
		expect(csp).toContain("img-src 'self' data: https://media.bettersleep.ro");
	});

	it('derives the media origin from S3 when MEDIA_PUBLIC_BASE_URL is absent (dev)', () => {
		const csp = runtimeCspDirectives(
			{ S3_ENDPOINT: 'http://localhost:9000', S3_BUCKET: 'better-base-media' },
			{ isAdmin: false }
		);
		expect(csp).toContain("img-src 'self' data: http://localhost:9000");
	});

	it('adds the bucket endpoint to connect-src on admin only (direct uploads)', () => {
		const admin = runtimeCspDirectives(PROD_ENV, { isAdmin: true });
		const publicHalf = runtimeCspDirectives(PROD_ENV, { isAdmin: false });
		expect(admin).toContain(
			"connect-src 'self' https://plausible.io https://abc123.r2.cloudflarestorage.com"
		);
		expect(publicHalf).toContain("connect-src 'self' https://plausible.io");
		expect(publicHalf).not.toContain('r2.cloudflarestorage.com');
	});

	it('pins form-action to self + Stripe Checkout and forbids framing', () => {
		const csp = runtimeCspDirectives(PROD_ENV, { isAdmin: false });
		expect(csp).toContain("form-action 'self' https://checkout.stripe.com");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain(
			'frame-src https://www.youtube-nocookie.com https://iframe.mediadelivery.net'
		);
	});

	it('never repeats a source when two env vars share an origin', () => {
		const csp = runtimeCspDirectives(
			{
				MEDIA_PUBLIC_BASE_URL: 'https://media.x.ro',
				CF_IMAGE_BASE_URL: 'https://media.x.ro'
			},
			{ isAdmin: false }
		);
		expect(csp.match(/https:\/\/media\.x\.ro/g)).toHaveLength(1);
	});
});

describe('applySecurityHeaders', () => {
	it('sends HSTS only for an https PUBLIC_SITE_URL', () => {
		const https = new Response('x');
		applySecurityHeaders(https, PROD_ENV, { isAdmin: false });
		expect(https.headers.get('strict-transport-security')).toBe(
			'max-age=63072000; includeSubDomains'
		);

		const http = new Response('x');
		applySecurityHeaders(
			http,
			{ ...PROD_ENV, PUBLIC_SITE_URL: 'http://localhost:5173' },
			{
				isAdmin: false
			}
		);
		expect(http.headers.get('strict-transport-security')).toBeNull();
	});

	it('appends the runtime half after an existing kit CSP header', () => {
		const response = new Response('x', {
			headers: { 'content-security-policy': "script-src 'self' 'strict-dynamic'" }
		});
		applySecurityHeaders(response, PROD_ENV, { isAdmin: false });
		const csp = response.headers.get('content-security-policy')!;
		expect(csp.startsWith("script-src 'self' 'strict-dynamic'; img-src")).toBe(true);
	});

	it('forces no-store on admin responses and leaves public cacheability alone', () => {
		const admin = new Response('x');
		applySecurityHeaders(admin, PROD_ENV, { isAdmin: true });
		expect(admin.headers.get('cache-control')).toBe('private, no-store');

		const publicResponse = new Response('x');
		applySecurityHeaders(publicResponse, PROD_ENV, { isAdmin: false });
		expect(publicResponse.headers.get('cache-control')).toBeNull();
	});
});
