import { eq } from 'drizzle-orm';
import { PILLARS_BY_SLUG } from '../config/pillars.ts';
import { articlePillars, articles } from '../modules/blog/schema.ts';
import type { Db } from './client.ts';
import { pillars } from './schema/core.ts';

/**
 * Upsert the given pillar slugs (in order) from the canonical definitions.
 * Idempotent: re-running updates rows in place and never duplicates.
 */
export async function seedPillars(db: Db, pillarSlugs: string[]): Promise<number> {
	let count = 0;
	for (const [index, slug] of pillarSlugs.entries()) {
		const def = PILLARS_BY_SLUG.get(slug);
		if (!def) throw new Error(`Cannot seed unknown pillar slug "${slug}"`);
		await db
			.insert(pillars)
			.values({ slug: def.slug, name: def.name, description: def.description, sort: index })
			.onConflictDoUpdate({
				target: pillars.slug,
				set: { name: def.name, description: def.description, sort: index }
			});
		count++;
	}
	return count;
}

/**
 * Three published demo articles (ro), tagged to the `somn` pillar — both sites
 * activate it, so dev environments always have visible blog content.
 * Idempotent: fixed ids + upsert-by-slug, re-running never duplicates.
 */
const DEMO_ARTICLES = [
	{
		id: 'seed-article-cicluri-somn',
		slug: 'ciclurile-somnului-explicate',
		title: 'Ciclurile somnului, explicate simplu',
		excerpt:
			'Ce se întâmplă în creierul tău în fiecare noapte și de ce contează fiecare fază a somnului.',
		bodyMd:
			'Somnul nu este o stare uniformă: în fiecare noapte treci prin **4–6 cicluri** de aproximativ 90 de minute.\n\n## Fazele unui ciclu\n\n- **Somn ușor** — tranziția către odihnă, ușor de întrerupt.\n- **Somn profund** — refacerea fizică; aici corpul repară țesuturi.\n- **Somn REM** — visele și consolidarea memoriei.\n\nTrezirile scurte între cicluri sunt normale. Contează ca ele să rămână scurte.\n',
		publishedAt: new Date('2026-06-01T08:00:00Z')
	},
	{
		id: 'seed-article-igiena-somnului',
		slug: 'igiena-somnului-7-reguli',
		title: 'Igiena somnului: 7 reguli care chiar funcționează',
		excerpt:
			'Obiceiuri mici, susținute de studii, care îți îmbunătățesc somnul în câteva săptămâni.',
		bodyMd:
			'Nu ai nevoie de gadgeturi scumpe ca să dormi mai bine. Începe cu aceste reguli:\n\n1. Oră fixă de culcare și de trezire, inclusiv în weekend.\n2. Dormitor răcoros (18–20 °C), întunecat și liniștit.\n3. Fără cafeină după ora 14:00.\n4. Fără ecrane cu o oră înainte de culcare.\n5. Lumină naturală dimineața, în primele 30 de minute.\n6. Mișcare zilnică, dar nu chiar înainte de somn.\n7. Patul doar pentru somn — nu pentru lucru sau scroll.\n\n> Consecvența bate perfecțiunea: alege două reguli și ține-te de ele două săptămâni.\n',
		publishedAt: new Date('2026-06-10T08:00:00Z')
	},
	{
		id: 'seed-article-melatonina',
		slug: 'melatonina-si-lumina-albastra',
		title: 'Melatonina și lumina albastră: ce spune știința',
		excerpt:
			'Cum îți reglează lumina hormonul somnului și ce poți face seara ca să adormi mai ușor.',
		bodyMd:
			'**Melatonina** este semnalul biochimic al întunericului: creierul o secretă seara, când lumina scade.\n\nEcranele și becurile puternice — în special componenta lor **albastră** — întârzie această secreție și împing ora la care poți adormi.\n\n## Ce poți face\n\n- Redu intensitatea luminii în casă cu 1–2 ore înainte de culcare.\n- Activează filtrul de lumină caldă pe telefon după apus.\n- Dimineața, expune-te la lumină naturală: resetează ceasul intern.\n',
		publishedAt: new Date('2026-06-20T08:00:00Z')
	}
];

export async function seedDemoArticles(db: Db): Promise<number> {
	const [somn] = await db.select().from(pillars).where(eq(pillars.slug, 'somn'));
	if (!somn) throw new Error('Cannot seed demo articles: the "somn" pillar is not seeded');

	for (const demo of DEMO_ARTICLES) {
		const { id, ...content } = demo;
		const [row] = await db
			.insert(articles)
			.values({ id, ...content, status: 'published' })
			.onConflictDoUpdate({ target: articles.slug, set: { ...content, status: 'published' } })
			.returning();
		await db
			.insert(articlePillars)
			.values({ articleId: row.id, pillarId: somn.id })
			.onConflictDoNothing();
	}
	return DEMO_ARTICLES.length;
}
