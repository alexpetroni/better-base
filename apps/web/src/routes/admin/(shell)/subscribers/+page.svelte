<script lang="ts">
	import { resolve } from '$app/paths';
	import { hasConsent } from '$lib/modules/crm';
	import { m } from '$lib/paraglide/messages';

	let { data } = $props();

	const dateFmt = new Intl.DateTimeFormat('ro-RO', { dateStyle: 'medium' });
</script>

<svelte:head>
	<title>{m.admin_nav_subscribers()}</title>
</svelte:head>

<div class="mb-4 flex items-center gap-3">
	<h1 class="grow text-2xl font-bold">{m.admin_nav_subscribers()}</h1>
	<a
		href={resolve('/admin/(shell)/subscribers/export.csv')}
		data-testid="subscribers-export"
		class="rounded bg-(--color-brand) px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
	>
		{m.admin_subs_export()}
	</a>
</div>

<form method="GET" class="mb-4 flex gap-2">
	<input
		type="search"
		name="q"
		value={data.search}
		data-testid="subscribers-search"
		placeholder={m.admin_subs_search_placeholder()}
		class="grow rounded border border-(--color-brand-soft) px-3 py-2 text-sm"
	/>
	<button type="submit" class="rounded bg-(--color-brand-soft) px-3 py-2 text-sm">
		{m.admin_articles_search()}
	</button>
</form>

{#if data.subscribers.length === 0}
	<p data-testid="subscribers-empty" class="text-(--color-ink)/70">{m.admin_subs_empty()}</p>
{:else}
	<table
		data-testid="subscribers-table"
		class="w-full rounded-lg border border-(--color-brand-soft) bg-white text-sm"
	>
		<thead>
			<tr class="border-b border-(--color-brand-soft) text-left">
				<th class="px-3 py-2">{m.admin_subs_col_email()}</th>
				<th class="px-3 py-2">{m.admin_subs_col_name()}</th>
				<th class="px-3 py-2">{m.admin_subs_col_newsletter()}</th>
				<th class="px-3 py-2">{m.admin_subs_col_profile()}</th>
				<th class="px-3 py-2">{m.admin_subs_col_confirmed()}</th>
				<th class="px-3 py-2">{m.admin_subs_col_created()}</th>
			</tr>
		</thead>
		<tbody>
			{#each data.subscribers as sub (sub.id)}
				<tr
					data-testid="subscriber-row"
					data-email={sub.email}
					class="border-b border-(--color-brand-soft)/50"
				>
					<td class="px-3 py-2 font-medium">{sub.email}</td>
					<td class="px-3 py-2">{sub.name ?? '—'}</td>
					<td class="px-3 py-2" data-testid="subscriber-newsletter">
						{#if hasConsent(sub.consents, 'newsletter')}
							<span class="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800"
								>{m.admin_subs_consent_yes()}</span
							>
							<span class="block text-xs text-(--color-ink)/50"
								>{sub.consents.newsletter?.source}</span
							>
						{:else}
							<span class="rounded bg-(--color-brand-soft) px-2 py-0.5 text-xs"
								>{m.admin_subs_consent_no()}</span
							>
						{/if}
					</td>
					<td class="px-3 py-2" data-testid="subscriber-profile-consent">
						{#if hasConsent(sub.consents, 'profile_emails')}
							<span class="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800"
								>{m.admin_subs_consent_yes()}</span
							>
						{:else}
							<span class="rounded bg-(--color-brand-soft) px-2 py-0.5 text-xs"
								>{m.admin_subs_consent_no()}</span
							>
						{/if}
					</td>
					<td class="px-3 py-2" data-testid="subscriber-confirmed">
						{sub.confirmedAt ? m.admin_subs_consent_yes() : m.admin_subs_consent_no()}
					</td>
					<td class="px-3 py-2 text-(--color-ink)/70">{dateFmt.format(sub.createdAt)}</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
