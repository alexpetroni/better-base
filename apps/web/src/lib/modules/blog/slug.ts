/**
 * URL slug generation. Pure: uniqueness against the database is handled by
 * the service layer, which feeds existing slugs into `nextUniqueSlug`.
 */

// Romanian diacritics, including the legacy cedilla forms (ş/ţ) still common
// in copy-pasted text. Everything else is handled by NFD decomposition.
const RO_MAP: Record<string, string> = {
	ă: 'a',
	â: 'a',
	î: 'i',
	ș: 's',
	ş: 's',
	ț: 't',
	ţ: 't'
};

export function slugify(input: string): string {
	const transliterated = input
		.toLowerCase()
		.replace(/[ăâîșşțţ]/g, (ch) => RO_MAP[ch])
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '');
	const slug = transliterated
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 96)
		.replace(/-+$/, '');
	return slug;
}

/**
 * First slug derived from `base` that is not taken: `base`, `base-2`,
 * `base-3`, … An empty base falls back to `articol`.
 */
export function nextUniqueSlug(base: string, isTaken: (slug: string) => boolean): string {
	const root = base || 'articol';
	if (!isTaken(root)) return root;
	for (let n = 2; ; n++) {
		const candidate = `${root}-${n}`;
		if (!isTaken(candidate)) return candidate;
	}
}
