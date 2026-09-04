import { describe, expect, it } from 'vitest';
import {
	BUCHAREST_COUNTY_CODE,
	bucharestSector,
	isRoCountyCode,
	RO_COUNTIES,
	roCountyCodeFor,
	roCountyName
} from './ro-counties.ts';

// CIUS-RO wants the ISO 3166-2:RO county code (`CountrySubentity`) on every
// Romanian address, and `SECTORn` as the city for București (audit
// 2026-09-03 P1 "the XML is not valid CIUS-RO for any Romanian address").
// Stripe hands us the county as free text; this table turns it into data.

describe('RO_COUNTIES', () => {
	it('lists the 41 județe plus București, each with an ISO 3166-2:RO code', () => {
		expect(RO_COUNTIES).toHaveLength(42);
		for (const county of RO_COUNTIES) {
			expect(county.code).toMatch(/^RO-[A-Z]{1,2}$/);
			expect(county.name.length).toBeGreaterThan(2);
		}
		expect(new Set(RO_COUNTIES.map((c) => c.code)).size).toBe(42);
		expect(BUCHAREST_COUNTY_CODE).toBe('RO-B');
		expect(isRoCountyCode('RO-CJ')).toBe(true);
		expect(isRoCountyCode('CJ')).toBe(false);
		expect(isRoCountyCode('RO-XX')).toBe(false);
		expect(roCountyName('RO-CJ')).toBe('Cluj');
		expect(roCountyName('RO-B')).toBe('București');
		expect(roCountyName('RO-XX')).toBeNull();
	});
});

describe('roCountyCodeFor', () => {
	it.each([
		['Cluj', 'RO-CJ'],
		['cluj', 'RO-CJ'],
		['Județul Cluj', 'RO-CJ'],
		['jud. Cluj', 'RO-CJ'],
		['CJ', 'RO-CJ'],
		['RO-CJ', 'RO-CJ'],
		['Bistrița-Năsăud', 'RO-BN'],
		['Bistrita Nasaud', 'RO-BN'], // no diacritics, hyphen dropped
		['Timiș', 'RO-TM'],
		['Timis', 'RO-TM'],
		['Satu Mare', 'RO-SM'],
		['București', 'RO-B'],
		['Bucuresti', 'RO-B'],
		['Bucharest', 'RO-B'],
		['Municipiul București', 'RO-B'],
		['Sector 3', 'RO-B'],
		['B', 'RO-B'],
		['Ilfov', 'RO-IF'],
		['', null],
		['   ', null],
		['Nowhere', null],
		['Transilvania', null]
	])('%s → %s', (input, code) => {
		expect(roCountyCodeFor(input)).toBe(code);
	});
});

describe('bucharestSector', () => {
	it('reads the sector number out of a city or street text', () => {
		expect(bucharestSector('Sector 3')).toBe(3);
		expect(bucharestSector('sectorul 5')).toBe(5);
		expect(bucharestSector('București, Sector 1')).toBe(1);
		expect(bucharestSector('Str. Viselor 10, sect. 2')).toBe(2);
		expect(bucharestSector('SECTOR6')).toBe(6);
		expect(bucharestSector('București')).toBeNull();
		expect(bucharestSector('Sector 7')).toBeNull();
		expect(bucharestSector('Sectorul Agricol Ilfov')).toBeNull();
	});
});
