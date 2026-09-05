import { describe, expect, it } from 'vitest';
import { looksLikeSvg, sanitizeSvg } from './svg.ts';

// FIX-15 (audit P1 media): `<style>` bodies used to survive sanitization, so
// `@import url(…)` and `url(http://…)` — remote fetches and a tracking beacon
// at best, CSS injection at worst — passed through "sanitize at rest".
describe('sanitizeSvg', () => {
	it('drops <style> elements and their bodies', () => {
		const out = sanitizeSvg(
			'<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.example/x.css);' +
				'rect{fill:url(https://evil.example/f.svg#g)}</style><rect width="1" height="1"/></svg>'
		);
		expect(out).not.toContain('<style');
		expect(out).not.toContain('@import');
		expect(out).not.toContain('evil.example');
		expect(out).toContain('<rect');
	});

	it('drops attributes whose value pulls a remote resource, keeps local url(#id) refs', () => {
		const out = sanitizeSvg(
			'<svg xmlns="http://www.w3.org/2000/svg">' +
				'<rect width="1" height="1" style="fill:url(https://evil.example/a.svg#p)" fill="url(#g)"/>' +
				'<circle r="1" style="fill:#fff" fill="url( \'https://evil.example/b\' )"/>' +
				'<path d="M0 0" style="@import url(x.css)"/>' +
				'</svg>'
		);
		expect(out).not.toContain('evil.example');
		expect(out).not.toContain('@import');
		expect(out).toContain('fill="url(#g)"');
		expect(out).toContain('style="fill:#fff"');
		expect(out).toContain('<path');
	});

	it('still strips scripts, handlers and javascript: refs', () => {
		const out = sanitizeSvg(
			'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script>' +
				'<a href="javascript:alert(3)"><rect width="1" height="1"/></a></svg>'
		);
		expect(out).not.toContain('<script');
		expect(out).not.toContain('onload');
		expect(out).not.toContain('javascript:');
		expect(out).toContain('<rect');
	});
});

describe('looksLikeSvg', () => {
	it('sniffs the root element', () => {
		expect(looksLikeSvg('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBe(true);
		expect(looksLikeSvg('<html><body>svg</body></html>')).toBe(false);
	});
});
