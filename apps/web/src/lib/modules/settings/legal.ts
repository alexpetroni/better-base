/**
 * Display model for the legally required trader identification (RO e-commerce:
 * company name, CUI, Reg. Com., registered address, contact) and the ANPC
 * SAL / EU SOL dispute-resolution links. Pure: derives everything from the
 * client-safe settings, so the footer and the legal pages render the SAME
 * data the operator saved in /admin/settings — nothing is ever hardcoded.
 *
 * Unset fields and still-seeded `PLACEHOLDER — …` values map to `null` so the
 * public UI degrades to "not shown" instead of leaking placeholder text;
 * `pnpm launch:check` refuses to launch while any launch-required field is in
 * that state.
 */
import { isSettingsPlaceholder, type PublicSiteSettings } from './registry.ts';

export interface LegalIdentity {
	legalName: string | null;
	/** Display form: bare CUI digits, `RO`-prefixed only when VAT-registered. */
	cui: string | null;
	regCom: string | null;
	address: string | null;
	contactEmail: string | null;
	contactPhone: string | null;
	anpcSalUrl: string | null;
	anpcSolUrl: string | null;
	extraNotices: string | null;
}

/**
 * The stored CUI may or may not carry the `RO` prefix (both pass validation);
 * display normalizes it: the prefix appears exactly when the company is
 * VAT-registered (the prefix IS the VAT registration marker in Romania).
 */
export function displayCui(cui: string, vatRegistered: boolean): string {
	const bare = cui.trim().replace(/^ro/i, '');
	return vatRegistered ? `RO${bare}` : bare;
}

function publicText(value: string): string | null {
	const trimmed = value.trim();
	return trimmed === '' || isSettingsPlaceholder(trimmed) ? null : trimmed;
}

export function legalIdentity(settings: PublicSiteSettings): LegalIdentity {
	const cui = publicText(settings['company.cui']);
	return {
		legalName: publicText(settings['company.legalName']),
		cui: cui === null ? null : displayCui(cui, settings['company.vatRegistered']),
		regCom: publicText(settings['company.regCom']),
		address: publicText(settings['company.address']),
		contactEmail: publicText(settings['company.contactEmail']),
		contactPhone: publicText(settings['company.contactPhone']),
		anpcSalUrl: publicText(settings['legal.anpcSalUrl']),
		anpcSolUrl: publicText(settings['legal.anpcSolUrl']),
		extraNotices: publicText(settings['legal.extraNotices'])
	};
}
