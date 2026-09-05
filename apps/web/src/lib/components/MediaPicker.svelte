<script lang="ts" module>
	import type { ImageSources } from '$lib/modules/media';

	/** One pickable library image, thumb pre-signed server-side. */
	export interface LibraryImage {
		id: string;
		key: string;
		filename: string;
		alt: string;
		thumb: ImageSources;
	}

	/** One page of the library (FIX-15: the picker no longer loads every row). */
	export interface LibraryPage {
		items: LibraryImage[];
		page: number;
		pageCount: number;
	}
</script>

<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { Img } from '$lib/modules/media';

	let {
		library,
		onpick,
		onclose
	}: {
		/** Page 1, from the editor's server load; further pages are fetched here. */
		library: LibraryPage;
		onpick: (item: LibraryImage) => void;
		onclose: () => void;
	} = $props();

	// The picker owns its paging state from the page the editor loaded.
	// svelte-ignore state_referenced_locally
	let current = $state<LibraryPage>(library);
	let loading = $state(false);

	async function goTo(page: number) {
		loading = true;
		try {
			const res = await fetch(`/admin/media/library?page=${page}`);
			if (res.ok) current = await res.json();
		} finally {
			loading = false;
		}
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
	data-testid="media-picker"
	role="dialog"
	aria-modal="true"
	aria-label={m.admin_article_picker_title()}
>
	<div class="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg bg-white shadow-xl">
		<div class="flex items-center justify-between border-b border-(--color-brand-soft) px-4 py-3">
			<h2 class="font-semibold">{m.admin_article_picker_title()}</h2>
			<button
				type="button"
				data-testid="media-picker-close"
				class="rounded px-2 py-1 text-sm hover:bg-(--color-brand-soft)"
				onclick={onclose}
			>
				{m.admin_article_picker_close()}
			</button>
		</div>
		<div class="overflow-y-auto p-4">
			{#if current.items.length === 0}
				<p data-testid="media-picker-empty" class="text-(--color-ink)/70">
					{m.admin_article_picker_empty()}
				</p>
			{:else}
				<ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
					{#each current.items as item (item.id)}
						<li>
							<button
								type="button"
								data-testid="media-picker-item"
								data-filename={item.filename}
								class="block w-full overflow-hidden rounded border border-(--color-brand-soft) hover:ring-2 hover:ring-(--color-brand)"
								onclick={() => onpick(item)}
							>
								<Img
									image={item.thumb}
									alt={item.alt || item.filename}
									class="aspect-[4/3] w-full bg-(--color-brand-soft)/20 object-cover"
								/>
								<span class="block truncate px-2 py-1 text-xs">{item.filename}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
			{#if current.pageCount > 1}
				<nav
					data-testid="media-picker-pagination"
					class="mt-4 flex items-center justify-between text-sm"
					aria-label={m.blog_page_of({ page: current.page, pageCount: current.pageCount })}
				>
					<button
						type="button"
						data-testid="media-picker-prev"
						class="rounded px-2 py-1 text-(--color-brand) hover:bg-(--color-brand-soft) disabled:opacity-40"
						disabled={loading || current.page <= 1}
						onclick={() => goTo(current.page - 1)}
					>
						← {m.blog_page_prev()}
					</button>
					<span class="text-(--color-ink)/60">
						{m.blog_page_of({ page: current.page, pageCount: current.pageCount })}
					</span>
					<button
						type="button"
						data-testid="media-picker-next"
						class="rounded px-2 py-1 text-(--color-brand) hover:bg-(--color-brand-soft) disabled:opacity-40"
						disabled={loading || current.page >= current.pageCount}
						onclick={() => goTo(current.page + 1)}
					>
						{m.blog_page_next()} →
					</button>
				</nav>
			{/if}
		</div>
	</div>
</div>
