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
import { displayCui } from '../../util/cui.ts';
import { isSettingsPlaceholder, type PublicSiteSettings } from './registry.ts';

// The CUI display rule lives with the checksum in $lib/util/cui.ts since
// FIX-12 (the invoice snapshot applies the same rule); re-exported so the
// module barrel keeps its shape.
export { displayCui };

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
