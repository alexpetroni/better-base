<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { COOKIE_INVENTORY, type CookieInventoryEntry } from './cookies.ts';

	// One row per inventory entry — the policy table is derived from code, so
	// it always matches what the app actually sets (cookies.spec.ts enforces
	// the inventory itself against the source).
	const PURPOSES: Record<CookieInventoryEntry['key'], () => string> = {
		auth_session: m.cookie_purpose_auth_session,
		cart: m.cookie_purpose_cart,
		consent: m.cookie_purpose_consent,
		chat_session: m.cookie_purpose_chat_session,
		locale: m.cookie_purpose_locale
	};
	const LIFETIMES: Record<CookieInventoryEntry['key'], () => string> = {
		auth_session: m.cookie_lifetime_auth_session,
		cart: m.cookie_lifetime_cart,
		consent: m.cookie_lifetime_consent,
		chat_session: m.cookie_lifetime_chat_session,
		locale: m.cookie_lifetime_locale
	};
</script>

<table data-testid="cookie-table" class="mt-6 w-full border-collapse text-sm">
	<caption class="mb-2 text-left font-semibold">{m.cookie_table_caption()}</caption>
	<thead>
		<tr class="border-b border-(--color-brand-soft) text-left">
			<th scope="col" class="py-2 pr-4">{m.cookie_table_name()}</th>
			<th scope="col" class="py-2 pr-4">{m.cookie_table_purpose()}</th>
			<th scope="col" class="py-2">{m.cookie_table_lifetime()}</th>
		</tr>
	</thead>
	<tbody>
		{#each COOKIE_INVENTORY as entry (entry.name)}
			<tr class="border-b border-(--color-brand-soft)/50 align-top">
				<td class="py-2 pr-4 font-mono text-xs">{entry.name}</td>
				<td class="py-2 pr-4">{PURPOSES[entry.key]()}</td>
				<td class="py-2">{LIFETIMES[entry.key]()}</td>
			</tr>
		{/each}
	</tbody>
</table>
<p data-testid="cookie-analytics-note" class="mt-4 text-sm text-(--color-ink)/70">
	{m.cookie_analytics_note()}
</p>
