import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import {
	isSettingGroup,
	parseSettingInput,
	SETTING_GROUPS,
	settingGroupKeys,
	SETTINGS_REGISTRY,
	validateSettingValue,
	type SettingErrorCode,
	type SettingJsonValue,
	type SettingKey
} from '$lib/modules/settings';
import { loadSettingsForAdmin, saveSettings } from '$lib/modules/settings/server';
import { failResult, formStr, requireAdmin } from '$lib/server/forms';
import { formatCents } from '$lib/util/money';
import type { Actions, PageServerLoad } from './$types';

/** The form's input string for a stored value (checkboxes stay boolean). */
function displayValue(key: SettingKey, value: string | number | boolean): string | boolean {
	const kind = SETTINGS_REGISTRY[key].kind;
	if (kind === 'boolean') return value as boolean;
	if (kind === 'bani') {
		// 4990 bani → "49,90" — drop the " lei" display unit.
		return formatCents(value as number).split(' ')[0];
	}
	return String(value);
}

export const load: PageServerLoad = async () => {
	const { settings, audit } = await loadSettingsForAdmin({ db: getDb() });
	return {
		audit,
		groups: SETTING_GROUPS.map((id) => ({
			id,
			fields: settingGroupKeys(id).map((key) => ({
				key,
				kind: SETTINGS_REGISTRY[key].kind,
				required: SETTINGS_REGISTRY[key].launchRequired,
				value: displayValue(key, settings[key])
			}))
		}))
	};
};

export const actions: Actions = {
	/**
	 * Save ONE group (forms are per-section so a half-configured site can still
	 * save its company data). Any invalid field re-renders the group with
	 * per-field errors and echoed input — nothing is written.
	 */
	save: async ({ request, locals }) => {
		const user = requireAdmin(locals);
		const form = await request.formData();
		const group = formStr(form, 'group');
		if (!isSettingGroup(group)) error(400, 'Unknown settings group');

		const entries: Partial<Record<SettingKey, SettingJsonValue>> = {};
		const errors: Partial<Record<SettingKey, SettingErrorCode>> = {};
		const values: Partial<Record<SettingKey, string | boolean>> = {};
		for (const key of settingGroupKeys(group)) {
			const raw = SETTINGS_REGISTRY[key].kind === 'boolean' ? form.has(key) : formStr(form, key);
			values[key] = raw;
			const parsed = parseSettingInput(key, raw);
			if (!parsed.ok) {
				errors[key] = parsed.code;
				continue;
			}
			const code = validateSettingValue(key, parsed.value);
			if (code) {
				errors[key] = code;
				continue;
			}
			entries[key] = parsed.value;
		}
		if (Object.keys(errors).length) return fail(400, { group, errors, values });

		const result = await saveSettings({ db: getDb() }, entries, user.id);
		if (!result.ok) return failResult(result, { group, errors, values });
		return { saved: true, group };
	}
};
