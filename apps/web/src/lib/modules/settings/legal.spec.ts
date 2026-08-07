import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { displayCui, legalIdentity } from './legal.ts';
import LegalIdentity from './LegalIdentity.svelte';
import { clientSafeSettings, settingsDefaults, type PublicSiteSettings } from './registry.ts';

/** All-fields-filled fixture — values are test data, never rendered anywhere real. */
function filledSettings(overrides: Partial<PublicSiteSettings> = {}): PublicSiteSettings {
	return {
		...clientSafeSettings(settingsDefaults()),
		'company.legalName': 'Exemplu Teste SRL',
		'company.cui': '12345678',
		'company.vatRegistered': true,
		'company.regCom': 'J40/1234/2024',
		'company.address': 'Str. Somnului 1\nBucurești',
		'company.contactEmail': 'contact@exemplu-teste.ro',
		'company.contactPhone': '+40 721 000 000',
		'legal.anpcSalUrl': 'https://anpc.ro/ce-este-sal/',
		'legal.anpcSolUrl': 'https://ec.europa.eu/consumers/odr',
		'legal.extraNotices': 'Capital social: 200 lei',
		...overrides
	};
}

describe('displayCui', () => {
	it('prefixes RO exactly when VAT-registered, never doubling it', () => {
		expect(displayCui('12345678', true)).toBe('RO12345678');
		expect(displayCui('RO12345678', true)).toBe('RO12345678');
		expect(displayCui('ro12345678', true)).toBe('RO12345678');
		expect(displayCui('12345678', false)).toBe('12345678');
		expect(displayCui('RO12345678', false)).toBe('12345678');
	});
});

describe('legalIdentity', () => {
	it('maps every filled field, applying the CUI display rule', () => {
		expect(legalIdentity(filledSettings())).toEqual({
			legalName: 'Exemplu Teste SRL',
			cui: 'RO12345678',
			regCom: 'J40/1234/2024',
			address: 'Str. Somnului 1\nBucurești',
			contactEmail: 'contact@exemplu-teste.ro',
			contactPhone: '+40 721 000 000',
			anpcSalUrl: 'https://anpc.ro/ce-este-sal/',
			anpcSolUrl: 'https://ec.europa.eu/consumers/odr',
			extraNotices: 'Capital social: 200 lei'
		});
	});

	it('treats unset, blank and still-seeded placeholder values as absent', () => {
		const identity = legalIdentity(
			filledSettings({
				'company.legalName': 'PLACEHOLDER — denumirea legală a companiei (ex. Exemplu SRL)',
				'company.contactPhone': '   ',
				'legal.extraNotices': ''
			})
		);
		expect(identity.legalName).toBeNull();
		expect(identity.contactPhone).toBeNull();
		expect(identity.extraNotices).toBeNull();
		// Untouched fields survive.
		expect(identity.regCom).toBe('J40/1234/2024');
	});

	it('never RO-prefixes a placeholder CUI', () => {
		const identity = legalIdentity(
			filledSettings({ 'company.cui': 'PLACEHOLDER — CUI / codul fiscal (ex. RO12345678)' })
		);
		expect(identity.cui).toBeNull();
	});
});

describe('LegalIdentity component (SSR)', () => {
	it('renders every required field from settings', () => {
		const { body } = render(LegalIdentity, { props: { settings: filledSettings() } });
		expect(body).toContain('Exemplu Teste SRL');
		expect(body).toContain('RO12345678');
		expect(body).toContain('J40/1234/2024');
		expect(body).toContain('Str. Somnului 1');
		expect(body).toContain('mailto:contact@exemplu-teste.ro');
		expect(body).toContain('+40 721 000 000');
		expect(body).toContain('Capital social: 200 lei');
	});

	it('renders the ANPC SAL and SOL links with the URLs from settings and rel=noopener', () => {
		const { body } = render(LegalIdentity, { props: { settings: filledSettings() } });
		for (const testid of ['legal-anpc-sal', 'legal-anpc-sol']) {
			const anchor = body.match(new RegExp(`<a[^>]*data-testid="${testid}"[^>]*>`, 'u'))?.[0];
			expect(anchor).toBeDefined();
			expect(anchor).toContain('rel="noopener"');
			expect(anchor).toContain('target="_blank"');
		}
		expect(body).toContain('href="https://anpc.ro/ce-este-sal/"');
		expect(body).toContain('href="https://ec.europa.eu/consumers/odr"');
	});

	it('degrades cleanly: absent optional fields render nothing, not empty labels', () => {
		const { body } = render(LegalIdentity, {
			props: {
				settings: filledSettings({
					'company.contactPhone': '',
					'legal.extraNotices': '',
					'legal.anpcSolUrl': ''
				})
			}
		});
		expect(body).not.toContain('legal-identity-phone');
		expect(body).not.toContain('legal-identity-extra');
		expect(body).not.toContain('legal-anpc-sol');
		// The rest still renders.
		expect(body).toContain('legal-anpc-sal');
		expect(body).toContain('Exemplu Teste SRL');
	});

	it('renders an empty shell on all-placeholder (fresh-seed) settings', () => {
		const { body } = render(LegalIdentity, {
			props: { settings: clientSafeSettings(settingsDefaults()) }
		});
		expect(body).not.toContain('PLACEHOLDER');
		expect(body).not.toContain('legal-anpc-sal');
	});
});

describe('no hardcoded company data', () => {
	// The law-required identification is DATA (site settings), never literals:
	// no component, route or site config may embed a Reg. Com. number, a CUI,
	// or the ANPC/SOL destinations. (Registry placeholders are hints, live in
	// registry.ts and are excluded from the public render by legalIdentity.)
	const FORBIDDEN = [
		/J\d{1,2}\/\d{1,7}\/\d{4}/u,
		/\bRO\d{6,10}\b/u,
		/anpc\.ro/iu,
		/ec\.europa\.eu/iu
	];

	function sourceFiles(dir: string, keep: (file: string) => boolean): string[] {
		return readdirSync(dir, { withFileTypes: true, recursive: true })
			.filter((entry) => entry.isFile())
			.map((entry) => path.join(entry.parentPath, entry.name))
			.filter((file) => keep(file) && !file.includes(`${path.sep}paraglide${path.sep}`));
	}

	it('finds none of the company/ANPC patterns in components, routes or site configs', () => {
		const srcRoot = path.resolve(import.meta.dirname, '../../..');
		const files = [
			...sourceFiles(path.join(srcRoot, 'lib'), (f) => f.endsWith('.svelte')),
			...sourceFiles(
				path.join(srcRoot, 'routes'),
				(f) => (f.endsWith('.svelte') || f.endsWith('.ts')) && !f.endsWith('.spec.ts')
			),
			...sourceFiles(path.join(srcRoot, 'lib/config'), (f) => f.endsWith('.ts'))
		];
		expect(files.length).toBeGreaterThan(20);
		for (const file of files) {
			const content = readFileSync(file, 'utf8');
			for (const pattern of FORBIDDEN) {
				expect(pattern.test(content), `${file} matches ${pattern}`).toBe(false);
			}
		}
	});
});
