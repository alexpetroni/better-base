/**
 * The 9 canonical pillars of a better life. Sites activate a subset of these
 * via their config (`pillars: string[]` of slugs); the seed script materializes
 * the active ones into the site's `pillars` table.
 */
export interface PillarDef {
	slug: string;
	name: string;
	description: string;
}

export const CANONICAL_PILLARS: readonly PillarDef[] = [
	{
		slug: 'somn',
		name: 'Somn',
		description: 'Odihnă profundă și un ritm de somn sănătos, noapte de noapte.'
	},
	{
		slug: 'nutritie',
		name: 'Nutriție',
		description: 'Alimentație echilibrată care îți susține energia și sănătatea.'
	},
	{
		slug: 'miscare',
		name: 'Mișcare',
		description: 'Activitate fizică regulată, adaptată corpului și vieții tale.'
	},
	{
		slug: 'stres',
		name: 'Gestionarea stresului',
		description: 'Tehnici practice pentru calm și reziliență în viața de zi cu zi.'
	},
	{
		slug: 'relatii',
		name: 'Relații',
		description: 'Legături apropiate și sănătoase cu oamenii din jurul tău.'
	},
	{
		slug: 'scop',
		name: 'Scop',
		description: 'Claritate asupra direcției și sensului în viața ta.'
	},
	{
		slug: 'mediu',
		name: 'Mediu',
		description: 'Spații de locuit și de lucru care îți susțin bunăstarea.'
	},
	{
		slug: 'minte',
		name: 'Minte',
		description: 'Sănătate mintală, atenție și obiceiuri care hrănesc gândirea.'
	},
	{
		slug: 'finante',
		name: 'Finanțe',
		description: 'Siguranță financiară și decizii care reduc grijile banilor.'
	}
] as const;

export const PILLARS_BY_SLUG: ReadonlyMap<string, PillarDef> = new Map(
	CANONICAL_PILLARS.map((p) => [p.slug, p])
);
