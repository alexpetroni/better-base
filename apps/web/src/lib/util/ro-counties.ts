/**
 * Romanian counties as DATA: the ISO 3166-2:RO codes CIUS-RO requires in
 * `CountrySubentity` for every Romanian address (BR-RO-030), plus the
 * București rule — under `RO-B` the city must be `SECTOR1`…`SECTOR6`
 * (BR-RO-A20). Stripe Checkout hands us the county as free text ("Cluj",
 * "Județul Cluj", "CJ", "Bucuresti"…); `roCountyCodeFor` turns that into a
 * code, `bucharestSector` finds the sector in a city or street text.
 *
 * Pure and dependency-free: shared by the settings registry (issuer seat),
 * the invoice service (buyer snapshot), the checkout's B2B form and the
 * cart page's county select.
 */

export interface RoCounty {
	/** ISO 3166-2:RO, e.g. `RO-CJ`. */
	code: string;
	name: string;
}

/** The platform's sale country (ISO 3166-1 alpha-2). */
export const ROMANIA_COUNTRY_CODE = 'RO';

export const BUCHAREST_COUNTY_CODE = 'RO-B';

export const RO_COUNTIES: readonly RoCounty[] = [
	{ code: 'RO-AB', name: 'Alba' },
	{ code: 'RO-AR', name: 'Arad' },
	{ code: 'RO-AG', name: 'Argeș' },
	{ code: 'RO-BC', name: 'Bacău' },
	{ code: 'RO-BH', name: 'Bihor' },
	{ code: 'RO-BN', name: 'Bistrița-Năsăud' },
	{ code: 'RO-BT', name: 'Botoșani' },
	{ code: 'RO-BV', name: 'Brașov' },
	{ code: 'RO-BR', name: 'Brăila' },
	{ code: 'RO-B', name: 'București' },
	{ code: 'RO-BZ', name: 'Buzău' },
	{ code: 'RO-CS', name: 'Caraș-Severin' },
	{ code: 'RO-CL', name: 'Călărași' },
	{ code: 'RO-CJ', name: 'Cluj' },
	{ code: 'RO-CT', name: 'Constanța' },
	{ code: 'RO-CV', name: 'Covasna' },
	{ code: 'RO-DB', name: 'Dâmbovița' },
	{ code: 'RO-DJ', name: 'Dolj' },
	{ code: 'RO-GL', name: 'Galați' },
	{ code: 'RO-GR', name: 'Giurgiu' },
	{ code: 'RO-GJ', name: 'Gorj' },
	{ code: 'RO-HR', name: 'Harghita' },
	{ code: 'RO-HD', name: 'Hunedoara' },
	{ code: 'RO-IL', name: 'Ialomița' },
	{ code: 'RO-IS', name: 'Iași' },
	{ code: 'RO-IF', name: 'Ilfov' },
	{ code: 'RO-MM', name: 'Maramureș' },
	{ code: 'RO-MH', name: 'Mehedinți' },
	{ code: 'RO-MS', name: 'Mureș' },
	{ code: 'RO-NT', name: 'Neamț' },
	{ code: 'RO-OT', name: 'Olt' },
	{ code: 'RO-PH', name: 'Prahova' },
	{ code: 'RO-SM', name: 'Satu Mare' },
	{ code: 'RO-SJ', name: 'Sălaj' },
	{ code: 'RO-SB', name: 'Sibiu' },
	{ code: 'RO-SV', name: 'Suceava' },
	{ code: 'RO-TR', name: 'Teleorman' },
	{ code: 'RO-TM', name: 'Timiș' },
	{ code: 'RO-TL', name: 'Tulcea' },
	{ code: 'RO-VS', name: 'Vaslui' },
	{ code: 'RO-VL', name: 'Vâlcea' },
	{ code: 'RO-VN', name: 'Vrancea' }
];

/** Lowercase ASCII words: diacritics folded, punctuation collapsed to spaces. */
function fold(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

const CODE_BY_NAME = new Map(RO_COUNTIES.map((county) => [fold(county.name), county.code]));
// Spellings Stripe's address form and customers actually produce.
const BUCHAREST_ALIASES = ['bucuresti', 'bucharest', 'municipiul bucuresti', 'b'];
const CODES = new Set(RO_COUNTIES.map((county) => county.code));

export function isRoCountyCode(value: string): boolean {
	return CODES.has(value);
}

export function roCountyName(code: string): string | null {
	return RO_COUNTIES.find((county) => county.code === code)?.name ?? null;
}

/**
 * Free text → ISO 3166-2:RO code, or null when it names no county. Accepts
 * the county name with or without diacritics, a `Județul …`/`jud. …`
 * prefix, the bare or `RO-` prefixed code, the București aliases, and a
 * `Sector n` (which is București by definition).
 */
export function roCountyCodeFor(text: string): string | null {
	const folded = fold(text).replace(/^(judetul|judet|jud) /, '');
	if (!folded) return null;
	if (/^sector(ul)? ?[1-6]$/.test(folded)) return BUCHAREST_COUNTY_CODE;
	if (BUCHAREST_ALIASES.includes(folded)) return BUCHAREST_COUNTY_CODE;
	const asCode = folded.replace(/^ro /, '').toUpperCase();
	if (/^[A-Z]{1,2}$/.test(asCode) && CODES.has(`RO-${asCode}`)) return `RO-${asCode}`;
	return CODE_BY_NAME.get(folded) ?? null;
}

/** The București sector named in a city or street text (`Sector 3`, `sect. 2`, `SECTOR6`), or null. */
export function bucharestSector(text: string): number | null {
	const match = /\bsect(?:or(?:ul)?|\.)\s*([1-6])(?!\d)/i.exec(text);
	return match ? Number(match[1]) : null;
}
