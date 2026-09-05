import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvField } from './csv.ts';

// FIX-12 CSV hygiene (audit P2): the accountant and subscriber exports are
// opened in Excel/LibreOffice, where a cell starting with = + - @ (or a tab /
// CR) is EXECUTED as a formula — customer-entered names are attacker input.
// A leading apostrophe neutralises it without changing what a human reads.

describe('csvField', () => {
	it('passes plain text through', () => {
		expect(csvField('Ana Pop', ';')).toBe('Ana Pop');
		expect(csvField('', ';')).toBe('');
		expect(csvField(null, ';')).toBe('');
	});

	it('quotes the delimiter, quotes and line breaks (doubling inner quotes)', () => {
		expect(csvField('Pop; Ana', ';')).toBe('"Pop; Ana"');
		expect(csvField('Pop, Ana', ',')).toBe('"Pop, Ana"');
		expect(csvField('say "hi"', ';')).toBe('"say ""hi"""');
		expect(csvField('a\nb', ';')).toBe('"a\nb"');
		expect(csvField('a\rb', ';')).toBe('"a\rb"');
	});

	it.each(['=', '+', '-', '@', '\t', '\r'])('neutralises a leading %j (formula injection)', (c) => {
		const field = csvField(`${c}HYPERLINK("https://evil.example")`, ';');
		expect(field.replace(/^"/, '').startsWith(`'${c}`)).toBe(true);
	});

	it('a neutralised field is still quoted when it needs to be', () => {
		expect(csvField('=1;2', ';')).toBe(`"'=1;2"`);
	});

	it('leaves a leading apostrophe alone (already inert)', () => {
		expect(csvField("'=1", ';')).toBe("'=1");
	});

	it('exports the UTF-8 BOM ro-RO Excel needs to read diacritics', () => {
		expect(CSV_BOM).toBe('\uFEFF');
	});
});
