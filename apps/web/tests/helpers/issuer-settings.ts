import type { SettingJsonValue, SettingKey } from '../../src/lib/modules/settings/registry.ts';

/**
 * The structured issuer address + share capital every invoice-issuing spec
 * needs since FIX-12 (CIUS-RO wants street / city / ISO 3166-2:RO county /
 * postal code on the seller; Legea 31/1990 art. 74 wants the share capital
 * on an SRL's documents). A București seat, so the SECTORn city rule is
 * exercised on every issuer party. Test data — no real entity.
 */
export const ISSUER_ADDRESS_SETTINGS: Partial<Record<SettingKey, SettingJsonValue>> = {
	'company.street': 'Str. Somnului 10',
	'company.city': 'Sector 3',
	'company.county': 'RO-B',
	'company.postalCode': '030167',
	'company.shareCapital': '200 lei'
};
