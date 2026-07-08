<script lang="ts">
	import { cn } from '../../utils.js';
	import { warningRing, optionFocus } from '../../styles.js';
	import { useTranslate } from '../../i18n.js';
	import FieldLabel from './FieldLabel.svelte';

	interface Props {
		min?: number;
		max?: number;
		value?: number | undefined;
		onchange?: (value: number) => void;
		name?: string;
		label?: string;
		tooltip?: string;
		minLabel?: string;
		maxLabel?: string;
		warning?: boolean;
		class?: string;
		optionClass?: string;
	}

	let { min = 1, max = 10, value = $bindable(), onchange, name = 'scale', label, tooltip, minLabel, maxLabel, warning = false, class: className, optionClass }: Props = $props();

	const translate = useTranslate();

	function handleSelect(n: number) {
		value = n;
		onchange?.(n);
	}

	const numbers = $derived(Array.from({ length: max - min + 1 }, (_, i) => min + i));
</script>

<fieldset aria-label={label ? undefined : name} class={className}>
	{#if label}
		<FieldLabel tag="legend" text={label} {tooltip} />
	{/if}
	<div
		class={cn(
			'flex flex-col gap-2 rounded-(--form-radius) p-1',
			warning && cn(warningRing, 'p-3')
		)}
	>
		<div class="flex flex-wrap gap-2 justify-center">
			{#each numbers as n (n)}
				{@const selected = value === n}
				<label
					class={cn(
						'flex cursor-pointer items-center justify-center rounded-full size-10 text-sm font-medium border transition-all',
						optionFocus,
						selected
							? 'bg-(--form-accent) text-(--form-accent-foreground) border-(--form-accent)'
							: 'border-(--form-border) bg-(--form-bg) hover:bg-(--form-accent)/10',
						optionClass
					)}
				>
					<input
						type="radio"
						{name}
						value={n}
						checked={selected}
						onchange={() => handleSelect(n)}
						class="sr-only"
					/>
					<span>{n}</span>
				</label>
			{/each}
		</div>
		{#if minLabel || maxLabel}
			<div class="flex justify-between text-xs text-(--form-muted) px-1">
				<span>{minLabel ? translate(minLabel) : ''}</span>
				<span>{maxLabel ? translate(maxLabel) : ''}</span>
			</div>
		{/if}
	</div>
</fieldset>
