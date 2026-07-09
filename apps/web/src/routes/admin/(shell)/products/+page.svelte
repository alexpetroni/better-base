<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import { m } from '$lib/paraglide/messages';
	import { formatCents } from '$lib/modules/shop';

	let { data, form } = $props();

	const filters = [
		{ value: 'all', label: m.admin_products_filter_all },
		{ value: 'draft', label: m.admin_products_filter_draft },
		{ value: 'active', label: m.admin_products_filter_active },
		{ value: 'archived', label: m.admin_products_filter_archived }
	];

	const statusLabels: Record<string, () => string> = {
		draft: m.admin_product_status_draft,
		active: m.admin_product_status_active,
		archived: m.admin_product_status_archived
	};

	// A resolved pathname plus a query string is still a resolved destination.
	function filterHref(status: string): ResolvedPathname {
		const params: string[] = [];
		if (status !== 'all') params.push(`status=${status}`);
		if (data.filter.search) params.push(`q=${encodeURIComponent(data.filter.search)}`);
		const qs = params.length ? `?${params.join('&')}` : '';
		return `${resolve('/admin/products')}${qs}` as ResolvedPathname;
	}

	const dateFmt = new Intl.DateTimeFormat('ro-RO', { dateStyle: 'medium' });
</script>

<svelte:head>
	<title>{m.admin_nav_products()}</title>
</svelte:head>

<h1 class="mb-4 text-2xl font-bold">{m.admin_nav_products()}</h1>

<form method="POST" action="?/create" class="mb-6 flex gap-2">
	<input
		type="text"
		name="name"
		required
		data-testid="product-new-name"
		placeholder={m.admin_products_new_placeholder()}
		class="grow rounded border border-(--color-brand-soft) px-3 py-2"
	/>
	<button
		type="submit"
		data-testid="product-create"
		class="rounded bg-(--color-brand) px-4 py-2 font-semibold text-white hover:opacity-90"
	>
		{m.admin_products_create()}
	</button>
</form>
{#if form?.error}
	<p data-testid="product-create-error" class="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
		{m.admin_product_err_name()}
	</p>
{/if}

<div class="mb-4 flex flex-wrap items-center gap-2">
	<nav class="flex gap-1" data-testid="product-status-filter">
		{#each filters as f (f.value)}
			<a
				href={filterHref(f.value)}
				class="rounded px-3 py-1 text-sm {data.filter.status === f.value
					? 'bg-(--color-brand) font-semibold text-white'
					: 'bg-(--color-brand-soft)/50 hover:bg-(--color-brand-soft)'}"
			>
				{f.label()}
			</a>
		{/each}
	</nav>
	<form method="GET" class="ml-auto flex gap-2">
		{#if data.filter.status !== 'all'}
			<input type="hidden" name="status" value={data.filter.status} />
		{/if}
		<input
			type="search"
			name="q"
			value={data.filter.search}
			data-testid="product-search"
			placeholder={m.admin_products_search_placeholder()}
			class="rounded border border-(--color-brand-soft) px-3 py-1 text-sm"
		/>
		<button type="submit" class="rounded bg-(--color-brand-soft) px-3 py-1 text-sm">
			{m.admin_products_search()}
		</button>
	</form>
</div>

{#if data.products.length === 0}
	<p data-testid="products-empty" class="text-(--color-ink)/70">{m.admin_products_empty()}</p>
{:else}
	<ul
		class="divide-y divide-(--color-brand-soft) rounded-lg border border-(--color-brand-soft) bg-white"
	>
		{#each data.products as product (product.id)}
			<li>
				<a
					href={resolve('/admin/(shell)/products/[id]', { id: product.id })}
					data-testid="product-row"
					data-slug={product.slug}
					class="flex items-center gap-3 px-4 py-3 hover:bg-(--color-brand-soft)/20"
				>
					<span class="min-w-0 grow">
						<span class="block truncate font-medium">{product.name}</span>
						<span class="block truncate text-sm text-(--color-ink)/60">/{product.slug}</span>
					</span>
					<span data-testid="product-row-price" class="shrink-0 text-sm font-semibold">
						{formatCents(product.priceCents, product.currency)}
					</span>
					{#if product.stock !== null}
						<span class="shrink-0 text-xs text-(--color-ink)/60">
							stoc: {product.stock}
						</span>
					{/if}
					<span
						data-testid="product-row-sync"
						title={product.stripeProductId && product.stripePriceId
							? m.admin_product_synced()
							: m.admin_product_not_synced()}
						class="shrink-0 rounded px-2 py-0.5 text-xs
							{product.stripeProductId && product.stripePriceId
							? 'bg-blue-100 text-blue-800'
							: 'bg-(--color-brand-soft) text-(--color-ink)/70'}"
					>
						{product.stripeProductId && product.stripePriceId ? 'stripe ✓' : 'stripe —'}
					</span>
					<span class="shrink-0 text-xs text-(--color-ink)/60">
						{m.admin_products_updated({ date: dateFmt.format(product.updatedAt) })}
					</span>
					<span
						data-testid="product-row-status"
						class="shrink-0 rounded px-2 py-0.5 text-xs font-semibold
							{product.status === 'active'
							? 'bg-green-100 text-green-800'
							: product.status === 'archived'
								? 'bg-gray-200 text-gray-700'
								: 'bg-(--color-brand-soft) text-(--color-ink)'}"
					>
						{statusLabels[product.status]()}
					</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}
