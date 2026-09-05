// Server module barrel: schema + db services for site settings, plus the
// pure registry helpers server-side modules consume (invoice issuance).
export { isSettingsPlaceholder, settingsConsistencyProblems } from './registry.ts';
export { siteSettings, type SiteSettingRow } from './schema.ts';
export {
	autoMigratedVatSchedule,
	createSettingsLoader,
	loadSettings,
	loadSettingsForAdmin,
	saveSettings,
	settingsLaunchProblems,
	type SettingsAudit,
	type SettingsDeps,
	type SettingsError,
	type SettingsResult
} from './service.ts';
