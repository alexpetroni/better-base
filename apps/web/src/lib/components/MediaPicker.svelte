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
</script>

<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { Img } from '$lib/modules/media';

	let {
		items,
		onpick,
		onclose
	}: {
		items: LibraryImage[];
		onpick: (item: LibraryImage) => void;
		onclose: () => void;
	} = $props();
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
			{#if items.length === 0}
				<p data-testid="media-picker-empty" class="text-(--color-ink)/70">
					{m.admin_article_picker_empty()}
				</p>
			{:else}
				<ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
					{#each items as item (item.id)}
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
		</div>
	</div>
</div>
