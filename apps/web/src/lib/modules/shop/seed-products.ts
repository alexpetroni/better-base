/**
 * Demo product seed data: 3 sleep-pillar products with SVG placeholder
 * images (uploaded to storage by the seed, no binaries in the repo).
 * Fixed ids/keys so re-seeding is idempotent.
 */

export interface DemoMediaSeed {
	id: string;
	key: string;
	filename: string;
	alt: string;
	width: number;
	height: number;
	svg: string;
}

export interface DemoProductSeed {
	id: string;
	slug: string;
	name: string;
	descriptionMd: string;
	/** Integer bani. */
	priceCents: number;
	/** null = untracked stock. */
	stock: number | null;
	cover: DemoMediaSeed;
	gallery: DemoMediaSeed[];
}

function placeholderSvg(label: string, from: string, to: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
</linearGradient></defs>
<rect width="800" height="600" fill="url(#g)"/>
<circle cx="650" cy="120" r="60" fill="#ffffff" opacity="0.25"/>
<text x="400" y="315" font-family="Arial, sans-serif" font-size="40" font-weight="bold" fill="#ffffff" text-anchor="middle">${label}</text>
</svg>`;
}

function demoMedia(idSuffix: string, alt: string, from: string, to: string): DemoMediaSeed {
	return {
		id: `seed-media-${idSuffix}`,
		key: `seed/products/${idSuffix}.svg`,
		filename: `${idSuffix}.svg`,
		alt,
		width: 800,
		height: 600,
		svg: placeholderSvg(alt, from, to)
	};
}

export const DEMO_PRODUCTS: DemoProductSeed[] = [
	{
		id: 'seed-product-masca-somn',
		slug: 'masca-de-somn-premium',
		name: 'Mască de somn premium',
		descriptionMd:
			'Mască de somn din mătase, cu blocare totală a luminii.\n\n- Bandă reglabilă, fără presiune pe ochi\n- Materiale hipoalergenice\n- Husă de transport inclusă\n\nSomn profund, oriunde ai fi.\n',
		priceCents: 8990,
		stock: 25,
		cover: demoMedia('masca-somn', 'Mască de somn premium', '#4c4b9e', '#8b8ad0'),
		gallery: [demoMedia('masca-somn-detaliu', 'Mască de somn — detaliu', '#6a69b8', '#a5a4e0')]
	},
	{
		id: 'seed-product-ceai-seara',
		slug: 'ceai-de-seara-cu-musetel',
		name: 'Ceai de seară cu mușețel și lavandă',
		descriptionMd:
			'Amestec de plante pentru un ritual de seară liniștitor: mușețel, lavandă și tei.\n\n- 30 de plicuri biodegradabile\n- Fără cofeină\n- Ingrediente din culturi ecologice\n',
		priceCents: 3450,
		stock: null,
		cover: demoMedia('ceai-seara', 'Ceai de seară cu mușețel', '#3e7d5a', '#7ab893'),
		gallery: []
	},
	{
		id: 'seed-product-lumina-veghe',
		slug: 'lumina-de-veghe-spectru-cald',
		name: 'Lumină de veghe cu spectru cald',
		descriptionMd:
			'Veioză cu lumină caldă (2200K) care nu suprimă melatonina — ideală pentru citit înainte de culcare.\n\n- Intensitate reglabilă în 3 trepte\n- Oprire automată după 30 de minute\n- Alimentare USB-C\n',
		priceCents: 12900,
		stock: 8,
		cover: demoMedia('lumina-veghe', 'Lumină de veghe cu spectru cald', '#a8642a', '#e0a05c'),
		gallery: []
	}
];
