/**
 * Default legal pages, seeded once per site database (never overwritten —
 * see `ensurePage`). The copy is an honest ro skeleton covering what the
 * platform actually does; a lawyer MUST review it before launch
 * (tracked in LAUNCH-CHECKLIST.md). No brand strings here: the pages speak
 * about "acest site" and the site name appears only in rendered context.
 */

export const PRIVACY_PAGE_SLUG = 'politica-de-confidentialitate';
export const TERMS_PAGE_SLUG = 'termeni-si-conditii';

export const DEFAULT_PAGES = [
	{
		id: 'seed-page-privacy',
		slug: PRIVACY_PAGE_SLUG,
		title: 'Politica de confidențialitate',
		seoDescription:
			'Ce date personale colectează acest site, în ce scop și ce drepturi ai conform GDPR.',
		bodyMd: `_Ultima actualizare: iulie 2026. Acest text este un model de lucru și trebuie revizuit de un consilier juridic înainte de lansare._

## Ce date colectăm

- **Adresa de email** — când te abonezi la newsletter sau ceri rezultatul unui chestionar pe email. Abonarea la newsletter se activează doar după confirmarea prin email (dublu opt-in).
- **Răspunsurile la chestionare** — pentru a calcula și a-ți afișa rezultatul. Ele nu sunt asociate cu emailul tău decât dacă ni-l dai explicit.
- **Datele comenzilor** — email și adresa de livrare, colectate de procesatorul de plăți la finalizarea unei comenzi. Nu stocăm date de card; plățile sunt procesate de Stripe.
- **Conversațiile cu asistentul virtual** — mesajele din chat sunt păstrate cel mult 30 de zile, fără a fi asociate cu o identitate.

## Cookie-uri

Folosim cookie-uri strict necesare (coșul de cumpărături, sesiunea de chat, sesiunea de administrare). Cookie-uri de analiză sau marketing se activează numai cu acordul tău, exprimat prin bannerul de consimțământ — în lipsa acordului nu se încarcă niciun script de analiză.

## Cui transmitem date

Folosim furnizori de servicii care prelucrează date în numele nostru: procesator de plăți (Stripe), serviciu de trimitere email (Resend), găzduire și stocare media. Nu vindem datele tale.

## Cât timp păstrăm datele

- Abonamente la newsletter: până la dezabonare sau la cererea de ștergere.
- Rezultatele chestionarelor: până la cererea de ștergere a contului de abonat.
- Comenzile: conform obligațiilor legale de arhivare contabilă.
- Conversațiile de chat: maximum 30 de zile.

## Drepturile tale

Ai dreptul de acces, rectificare, ștergere, restricționare și portabilitate a datelor, precum și dreptul de a-ți retrage consimțământul oricând. Pentru newsletter, fiecare email conține un link de dezabonare. Pentru ștergerea completă a datelor, scrie-ne la adresa de contact a site-ului și vom șterge datele de abonat și vom anonimiza comenzile și rezultatele asociate.

Ai și dreptul de a depune o plângere la Autoritatea Națională de Supraveghere a Prelucrării Datelor cu Caracter Personal (ANSPDCP).`
	},
	{
		id: 'seed-page-terms',
		slug: TERMS_PAGE_SLUG,
		title: 'Termeni și condiții',
		seoDescription: 'Condițiile de utilizare a acestui site și a magazinului online.',
		bodyMd: `_Ultima actualizare: iulie 2026. Acest text este un model de lucru și trebuie revizuit de un consilier juridic înainte de lansare._

## Despre conținut

Conținutul acestui site (articole, chestionare, răspunsurile asistentului virtual) are caracter informativ și educațional. **Nu reprezintă sfat medical** și nu înlocuiește consultul unui medic sau al unui specialist. Pentru probleme de sănătate, adresează-te unui profesionist.

## Chestionare și asistent virtual

Rezultatele chestionarelor sunt orientative. Asistentul virtual este un sistem automat; răspunsurile lui pot fi incomplete sau inexacte și nu constituie recomandări medicale.

## Magazin

- Prețurile sunt afișate în lei (RON) și includ TVA.
- Plata se face online, prin Stripe; nu stocăm datele cardului.
- Livrarea se face la adresa indicată la finalizarea comenzii.
- Ai dreptul de retragere din contract în 14 zile de la primirea produselor, conform OUG 34/2014. Pentru retururi și rambursări, folosește adresa de contact a site-ului.

## Proprietate intelectuală

Conținutul site-ului nu poate fi reprodus fără acord prealabil scris.

## Modificări

Putem actualiza acești termeni; versiunea curentă este întotdeauna cea publicată pe această pagină.`
	}
] as const;
