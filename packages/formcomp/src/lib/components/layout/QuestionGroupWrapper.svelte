<script lang="ts">
	import type { Snippet } from 'svelte';
	import { useTranslate } from '../../i18n.js';
	import { cn } from '../../utils.js';
	import { warningRing } from '../../styles.js';

	interface Props {
		id: string;
		label?: string;
		intro?: string;
		warning?: boolean;
		warningMessage?: string;
		class?: string;
		children: Snippet;
	}

	let {
		id,
		label,
		intro,
		warning = false,
		warningMessage = 'Please complete the required fields in this section.',
		class: className,
		children
	}: Props = $props();

	const translate = useTranslate();
</script>

<div id="formcomp-group-{id}" class={cn('scroll-mt-8', className)}>
	{#if label}
		<h3 class="text-sm font-semibold tracking-tight {intro ? 'mb-1' : 'mb-4'}">{translate(label)}</h3>
	{/if}
	{#if intro}
		<p class="text-sm text-(--form-muted) mb-4">{translate(intro)}</p>
	{/if}
	<div
		class={cn(
			'transition-all duration-200 rounded-(--form-radius)',
			warning && cn(warningRing, 'p-4')
		)}
	>
		{#if warning}
			<p role="alert" class="mb-4 text-sm font-medium text-(--form-error)">
				{translate(warningMessage)}
			</p>
		{/if}
		{@render children()}
	</div>
</div>
