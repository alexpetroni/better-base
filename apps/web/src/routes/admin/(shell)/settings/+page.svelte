<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import type { SettingGroup, SettingKey } from '$lib/modules/settings';
	import { formatDate } from '$lib/util/date';

	let { data, form } = $props();

	const groupLabels: Record<SettingGroup, () => string> = {
		company: m.admin_settings_group_company,
		legal: m.admin_settings_group_legal,
		invoice: m.admin_settings_group_invoice,
		shop: m.admin_settings_group_shop
	};

	const fieldLabels: Record<SettingKey, () => string> = {
		'company.legalName': m.admin_settings_company_legal_name,
		'company.cui': m.admin_settings_company_cui,
		'company.vatRegistered': m.admin_settings_company_vat_registered,
		'company.regCom': m.admin_settings_company_reg_com,
		'company.address': m.admin_settings_company_address,
		'company.contactEmail': m.admin_settings_company_contact_email,
		'company.contactPhone': m.admin_settings_company_contact_phone,
		'company.iban': m.admin_settings_company_iban,
		'company.bank': m.admin_settings_company_bank,
		'legal.anpcSalUrl': m.admin_settings_legal_anpc_sal,
		'legal.anpcSolUrl': m.admin_settings_legal_anpc_sol,
		'legal.extraNotices': m.admin_settings_legal_extra_notices,
		'invoice.seriesPrefix': m.admin_settings_invoice_series_prefix,
		'invoice.nextNumber': m.admin_settings_invoice_next_number,
		'invoice.issuerPlace': m.admin_settings_invoice_issuer_place,
		'invoice.vatRateBp': m.admin_settings_invoice_vat_rate,
		'invoice.paymentTermsNote': m.admin_settings_invoice_payment_terms,
		'invoice.vatUnregisteredMention': m.admin_settings_invoice_vat_unregistered_mention,
		'shop.freeShippingThresholdBani': m.admin_settings_shop_free_shipping,
		'shop.shippingStandardName': m.admin_settings_shop_shipping_standard_name,
		'shop.shippingStandardPriceBani': m.admin_settings_shop_shipping_standard_price,
		'shop.shippingStandardEta': m.admin_settings_shop_shipping_standard_eta,
		'shop.shippingExpressName': m.admin_settings_shop_shipping_express_name,
		'shop.shippingExpressPriceBani': m.admin_settings_shop_shipping_express_price,
		'shop.shippingExpressEta': m.admin_settings_shop_shipping_express_eta,
		'shop.shippingNote': m.admin_settings_shop_shipping_note,
		'shop.allowAllPaymentMethods': m.admin_settings_shop_allow_all_payment_methods
	};

	const errorLabels: Record<string, () => string> = {
		required: m.admin_settings_err_required,
		'invalid-url': m.admin_settings_err_url,
		'invalid-email': m.admin_settings_err_email,
		'invalid-number': m.admin_settings_err_number,
		'invalid-cui': m.admin_settings_err_cui,
		'too-long': m.admin_settings_err_too_long
	};

	function errorMessage(code: string): string {
		return (errorLabels[code] ?? m.admin_settings_err_value)();
	}

	/** A failed save echoes the group's raw input so nothing typed is lost. */
	function fieldValue(group: SettingGroup, key: SettingKey, loaded: string | boolean) {
		return form?.group === group && form.values && key in form.values
			? ((form.values as Partial<Record<SettingKey, string | boolean>>)[key] ?? loaded)
			: loaded;
	}
</script>

<svelte:head>
	<title>{m.admin_nav_settings()}</title>
</svelte:head>

<h1 class="mb-2 text-2xl font-bold">{m.admin_nav_settings()}</h1>
<p class="mb-1 text-sm text-(--color-ink)/70">{m.admin_settings_placeholder_hint()}</p>
{#if data.audit}
	<p data-testid="settings-audit" class="mb-4 text-sm text-(--color-ink)/70">
		{m.admin_settings_audit({
			email: data.audit.byEmail ?? '—',
			date: formatDate(data.audit.at, 'medium-time')
		})}
	</p>
{/if}

<div class="max-w-2xl space-y-8">
	{#each data.groups as group (group.id)}
		<form
			method="POST"
			action="?/save"
			class="rounded border border-(--color-brand-soft) bg-white p-4"
		>
			<input type="hidden" name="group" value={group.id} />
			<h2 class="mb-4 text-lg font-semibold">{groupLabels[group.id]()}</h2>

			<div class="space-y-4">
				{#each group.fields as field (field.key)}
					{@const value = fieldValue(group.id, field.key, field.value)}
					{@const fieldError = form?.group === group.id ? (form.errors?.[field.key] ?? null) : null}
					{#if field.kind === 'boolean'}
						<label class="flex items-center gap-2">
							<input
								type="checkbox"
								name={field.key}
								checked={value === true}
								data-testid="settings-field-{field.key}"
								class="h-4 w-4 accent-(--color-brand)"
							/>
							<span class="text-sm font-medium">{fieldLabels[field.key]()}</span>
						</label>
					{:else}
						<label class="block">
							<span class="mb-1 block text-sm font-medium">{fieldLabels[field.key]()}</span>
							{#if field.kind === 'multiline'}
								<textarea
									name={field.key}
									rows="3"
									data-testid="settings-field-{field.key}"
									class="w-full rounded border border-(--color-brand-soft) px-3 py-2 text-sm"
									>{value}</textarea
								>
							{:else}
								<input
									type="text"
									name={field.key}
									{value}
									inputmode={field.kind === 'int' ||
									field.kind === 'bani' ||
									field.kind === 'percentBp'
										? 'decimal'
										: undefined}
									data-testid="settings-field-{field.key}"
									class="w-full rounded border border-(--color-brand-soft) px-3 py-2 text-sm"
								/>
							{/if}
							{#if fieldError}
								<span
									data-testid="settings-error-{field.key}"
									class="mt-1 block text-sm text-red-700"
								>
									{errorMessage(fieldError)}
								</span>
							{/if}
						</label>
					{/if}
				{/each}
			</div>

			<div class="mt-4 flex items-center gap-3">
				<button
					type="submit"
					data-testid="settings-save-{group.id}"
					class="rounded bg-(--color-brand) px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
				>
					{m.admin_settings_save()}
				</button>
				{#if form?.saved && form.group === group.id}
					<span data-testid="settings-saved" class="text-sm text-green-700">
						{m.admin_settings_saved()}
					</span>
				{/if}
			</div>
		</form>
	{/each}
</div>
