<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import { m } from '$lib/paraglide/messages';

	let { data, form } = $props();

	const filters = [
		{ value: 'all', label: m.admin_articles_filter_all },
		{ value: 'draft', label: m.admin_articles_filter_draft },
		{ value: 'published', label: m.admin_articles_filter_published }
	];

	// A resolved pathname plus a query string is still a resolved destination.
	function filterHref(status: string): ResolvedPathname {
		const params: string[] = [];
		if (status !== 'all') params.push(`status=${status}`);
		if (data.filter.search) params.push(`q=${encodeURIComponent(data.filter.search)}`);
		const qs = params.length ? `?${params.join('&')}` : '';
		return `${resolve('/admin/articles')}${qs}` as ResolvedPathname;
	}

	const dateFmt = new Intl.DateTimeFormat('ro-RO', { dateStyle: 'medium' });
</script>

<svelte:head>
	<title>{m.admin_nav_articles()}</title>
</svelte:head>

<h1 class="mb-4 text-2xl font-bold">{m.admin_nav_articles()}</h1>

<form method="POST" action="?/create" class="mb-6 flex gap-2">
	<input
		type="text"
		name="title"
		required
		data-testid="article-new-title"
		placeholder={m.admin_articles_new_placeholder()}
		class="grow rounded border border-(--color-brand-soft) px-3 py-2"
	/>
	<button
		type="submit"
		data-testid="article-create"
		class="rounded bg-(--color-brand) px-4 py-2 font-semibold text-white hover:opacity-90"
	>
		{m.admin_articles_create()}
	</button>
</form>
{#if form?.error}
	<p data-testid="article-create-error" class="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
		{m.admin_article_err_invalid_title()}
	</p>
{/if}

<div class="mb-4 flex flex-wrap items-center gap-2">
	<nav class="flex gap-1" data-testid="article-status-filter">
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
			data-testid="article-search"
			placeholder={m.admin_articles_search_placeholder()}
			class="rounded border border-(--color-brand-soft) px-3 py-1 text-sm"
		/>
		<button type="submit" class="rounded bg-(--color-brand-soft) px-3 py-1 text-sm">
			{m.admin_articles_search()}
		</button>
	</form>
</div>

{#if data.articles.length === 0}
	<p data-testid="articles-empty" class="text-(--color-ink)/70">{m.admin_articles_empty()}</p>
{:else}
	<ul
		class="divide-y divide-(--color-brand-soft) rounded-lg border border-(--color-brand-soft) bg-white"
	>
		{#each data.articles as article (article.id)}
			<li>
				<a
					href={resolve('/admin/(shell)/articles/[id]', { id: article.id })}
					data-testid="article-row"
					data-slug={article.slug}
					class="flex items-center gap-3 px-4 py-3 hover:bg-(--color-brand-soft)/20"
				>
					<span class="min-w-0 grow">
						<span class="block truncate font-medium">{article.title}</span>
						<span class="block truncate text-sm text-(--color-ink)/60">/{article.slug}</span>
					</span>
					<span class="shrink-0 text-xs text-(--color-ink)/60">
						{m.admin_articles_updated({ date: dateFmt.format(article.updatedAt) })}
					</span>
					<span
						data-testid="article-status"
						class="shrink-0 rounded px-2 py-0.5 text-xs font-semibold
							{article.status === 'published'
							? 'bg-green-100 text-green-800'
							: 'bg-(--color-brand-soft) text-(--color-ink)'}"
					>
						{article.status === 'published'
							? m.admin_article_status_published()
							: m.admin_article_status_draft()}
					</span>
				</a>
			</li>
		{/each}
	</ul>
{/if}
