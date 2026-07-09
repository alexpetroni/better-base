<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>{data.page.title} · {m.admin_nav_pages()}</title>
</svelte:head>

<div class="mb-4 flex items-center justify-between">
	<h1 class="text-2xl font-bold">{data.page.title}</h1>
	<a
		href={resolve('/(public)/pagini/[slug]', { slug: data.page.slug })}
		data-testid="page-view-public"
		class="text-sm text-(--color-brand) hover:underline"
	>
		{m.admin_pages_view()} ↗
	</a>
</div>

{#if form?.saved}
	<p data-testid="page-saved" class="mb-4 rounded bg-green-50 p-3 text-sm text-green-800">
		{m.admin_pages_saved()}
	</p>
{/if}
{#if form?.error}
	<p data-testid="page-save-error" class="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
		{m.admin_pages_err_invalid_title()}
	</p>
{/if}

<form method="POST" action="?/save" class="space-y-4">
	<div>
		<label for="page-title" class="mb-1 block text-sm font-medium">
			{m.admin_pages_col_title()}
		</label>
		<input
			id="page-title"
			type="text"
			name="title"
			required
			value={data.page.title}
			data-testid="page-title"
			class="w-full rounded border border-(--color-brand-soft) px-3 py-2"
		/>
	</div>
	<p class="text-sm text-(--color-ink)/60">/pagini/{data.page.slug}</p>
	<div>
		<label for="page-body" class="mb-1 block text-sm font-medium">
			{m.admin_pages_body()}
		</label>
		<textarea
			id="page-body"
			name="bodyMd"
			rows="24"
			data-testid="page-body"
			class="w-full rounded border border-(--color-brand-soft) px-3 py-2 font-mono text-sm"
			>{data.page.bodyMd}</textarea
		>
	</div>
	<div>
		<label for="page-seo" class="mb-1 block text-sm font-medium">
			{m.admin_pages_seo_description()}
		</label>
		<input
			id="page-seo"
			type="text"
			name="seoDescription"
			value={data.page.seoDescription ?? ''}
			data-testid="page-seo-description"
			class="w-full rounded border border-(--color-brand-soft) px-3 py-2"
		/>
	</div>
	<button
		type="submit"
		data-testid="page-save"
		class="rounded bg-(--color-brand) px-4 py-2 font-semibold text-white hover:opacity-90"
	>
		{m.admin_pages_save()}
	</button>
</form>
