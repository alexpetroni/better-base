// Universal module barrel: the typed settings registry and its pure helpers,
// safe to import from components and client code. Everything db-bound lives
// behind `$lib/modules/settings/server` instead.
export { default as LegalIdentity } from './LegalIdentity.svelte';
export { displayCui, legalIdentity, type LegalIdentity as LegalIdentityFields } from './legal.ts';
export {
	clientSafeSettings,
	isSettingGroup,
	isSettingKey,
	isSettingsPlaceholder,
	LAUNCH_REQUIRED_SETTING_KEYS,
	mergeSettings,
	parseSettingInput,
	SETTING_GROUPS,
	settingGroupKeys,
	settingKeys,
	SETTINGS_PLACEHOLDER_PREFIX,
	SETTINGS_REGISTRY,
	settingsDefaults,
	validateSettingValue,
	type ClientSafeSettingKey,
	type ParsedSettingInput,
	type PublicSiteSettings,
	type SettingErrorCode,
	type SettingGroup,
	type SettingJsonValue,
	type SettingKey,
	type SettingKind,
	type SettingSpec,
	type SettingValue,
	type SiteSettings
} from './registry.ts';
export type { SiteSettingRow } from './schema.ts';
