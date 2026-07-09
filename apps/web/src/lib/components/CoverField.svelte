<script lang="ts">
	import { Img, type ImageSources } from '$lib/modules/media';

	// The cover sidebar card shared by the article and product editors. Labels
	// come in as props because message keys are namespaced per editor. The
	// parent keeps owning the MediaPicker; `onpick` just opens it in cover mode.
	let {
		coverMediaId = $bindable(),
		coverThumb = $bindable(),
		heading,
		noneText,
		pickText,
		removeText,
		aspectClass,
		testidPrefix,
		onpick
	}: {
		coverMediaId: string;
		coverThumb: ImageSources | null;
		heading: string;
		noneText: string;
		pickText: string;
		removeText: string;
		/** Preview aspect-ratio utility class, e.g. `aspect-[8/5]`. */
		aspectClass: string;
		testidPrefix: string;
		onpick: () => void;
	} = $props();
</script>

<div class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
	<h2 class="mb-2 text-sm font-semibold">{heading}</h2>
	<input type="hidden" name="coverMediaId" value={coverMediaId} />
	{#if coverThumb}
		<Img
			image={coverThumb}
			alt=""
			decorative
			class="mb-2 {aspectClass} w-full rounded bg-(--color-brand-soft)/20 object-cover"
		/>
	{:else}
		<p data-testid="{testidPrefix}-cover-none" class="mb-2 text-sm text-(--color-ink)/60">
			{noneText}
		</p>
	{/if}
	<div class="flex gap-2">
		<button
			type="button"
			data-testid="{testidPrefix}-cover-pick"
			class="rounded bg-(--color-brand-soft) px-3 py-1 text-sm hover:opacity-80"
			onclick={onpick}
		>
			{pickText}
		</button>
		{#if coverMediaId}
			<button
				type="button"
				data-testid="{testidPrefix}-cover-remove"
				class="rounded px-3 py-1 text-sm text-red-700 hover:bg-red-50"
				onclick={() => {
					coverMediaId = '';
					coverThumb = null;
				}}
			>
				{removeText}
			</button>
		{/if}
	</div>
</div>
