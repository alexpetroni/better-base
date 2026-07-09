<script lang="ts">
	import { formatDate } from '$lib/util/date';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>{m.admin_nav_pages()}</title>
</svelte:head>

<h1 class="mb-4 text-2xl font-bold">{m.admin_nav_pages()}</h1>

<form method="POST" action="?/create" class="mb-6 flex gap-2">
	<input
		type="text"
		name="title"
		required
		data-testid="page-new-title"
		placeholder={m.admin_pages_new_placeholder()}
		aria-label={m.admin_pages_new_placeholder()}
		class="grow rounded border border-(--color-brand-soft) px-3 py-2"
	/>
	<button
		type="submit"
		data-testid="page-create"
		class="rounded bg-(--color-brand) px-4 py-2 font-semibold text-white hover:opacity-90"
	>
		{m.admin_pages_create()}
	</button>
</form>
{#if form?.error}
	<p data-testid="page-create-error" class="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
		{m.admin_pages_err_invalid_title()}
	</p>
{/if}

<table class="w-full border-collapse text-sm" data-testid="pages-table">
	<thead>
		<tr class="border-b border-(--color-brand-soft) text-left">
			<th class="py-2 pr-4">{m.admin_pages_col_title()}</th>
			<th class="py-2 pr-4">{m.admin_pages_col_slug()}</th>
			<th class="py-2">{m.admin_pages_col_updated()}</th>
		</tr>
	</thead>
	<tbody>
		{#each data.pages as page (page.id)}
			<tr class="border-b border-(--color-brand-soft)/50">
				<td class="py-2 pr-4">
					<a
						href={resolve('/admin/(shell)/pages/[id]', { id: page.id })}
						data-testid="page-edit-{page.slug}"
						class="font-medium text-(--color-brand) hover:underline"
					>
						{page.title}
					</a>
				</td>
				<td class="py-2 pr-4 text-(--color-ink)/70">/pagini/{page.slug}</td>
				<td class="py-2 text-(--color-ink)/70">{formatDate(page.updatedAt)}</td>
			</tr>
		{:else}
			<tr><td colspan="3" class="py-4 text-(--color-ink)/60">{m.admin_pages_empty()}</td></tr>
		{/each}
	</tbody>
</table>
