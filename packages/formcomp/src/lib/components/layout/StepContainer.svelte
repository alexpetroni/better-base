<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../utils.js';
	import { useTranslate } from '../../i18n.js';

	interface Props {
		title?: string;
		intro?: string;
		class?: string;
		children: Snippet;
	}

	let { title, intro, class: className, children }: Props = $props();

	const translate = useTranslate();
</script>

<div class={cn('space-y-8', className)}>
	{#if title || intro}
		<div class="mb-6">
			{#if title}
				<!-- tabindex="-1" so MultiStepForm can move focus here on step change -->
				<h2 tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">{translate(title)}</h2>
			{/if}
			{#if intro}
				<p class="mt-2 text-sm text-(--form-muted)">{translate(intro)}</p>
			{/if}
		</div>
	{/if}
	{@render children()}
</div>
