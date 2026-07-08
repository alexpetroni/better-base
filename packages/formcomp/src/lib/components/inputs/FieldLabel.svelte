<script lang="ts">
	import { useTranslate } from '../../i18n.js';
	import { cn } from '../../utils.js';
	import { labelBase } from '../../styles.js';

	interface Props {
		/** Render as <label for={forId}> or as <legend> inside a fieldset */
		tag?: 'label' | 'legend';
		forId?: string;
		text: string;
		tooltip?: string;
		class?: string;
	}

	let { tag = 'label', forId, text, tooltip, class: className }: Props = $props();

	const translate = useTranslate();
</script>

<svelte:element
	this={tag}
	for={tag === 'label' ? forId : undefined}
	class={cn(labelBase, tag === 'legend' && 'mb-3', className)}
>
	{translate(text)}
	{#if tooltip}
		<span
			title={translate(tooltip)}
			aria-label={translate(tooltip)}
			role="img"
			class="ml-1 inline-flex cursor-help align-text-bottom text-(--form-muted)"
		>
			<svg class="size-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<circle cx="12" cy="12" r="10" />
				<path d="M12 16v-4" /><path d="M12 8h.01" />
			</svg>
		</span>
	{/if}
</svelte:element>
