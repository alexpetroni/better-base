<script lang="ts">
	import { cn } from '../../utils.js';
	import { inputBase, warningField } from '../../styles.js';
	import { useTranslate } from '../../i18n.js';
	import FieldLabel from './FieldLabel.svelte';

	interface Props {
		value?: number | undefined;
		onchange?: (value: number | undefined) => void;
		name?: string;
		label?: string;
		tooltip?: string;
		min?: number;
		max?: number;
		step?: number;
		placeholder?: string;
		unit?: string;
		warning?: boolean;
		class?: string;
	}

	let { value = $bindable(), onchange, name = 'number', label, tooltip, min, max, step, placeholder, unit, warning = false, class: className }: Props = $props();

	const translate = useTranslate();

	function handleInput(e: Event) {
		const input = e.target as HTMLInputElement;
		const raw = input.value;
		if (raw === '') {
			value = undefined;
			onchange?.(undefined);
			return;
		}
		let num = parseFloat(raw);
		if (isNaN(num)) return;
		if (min !== undefined && num < min) num = min;
		if (max !== undefined && num > max) num = max;
		value = num;
		onchange?.(num);
	}
</script>

<div class={cn('space-y-2', className)}>
	{#if label}
		<FieldLabel forId={name} text={label} {tooltip} />
	{/if}
	<div class="relative">
		<input
			type="number"
			{name}
			id={name}
			{min}
			{max}
			{step}
			value={value ?? ''}
			{placeholder}
			onchange={handleInput}
			class={cn(inputBase, unit && 'pr-12', warning && warningField)}
		/>
		{#if unit}
			<div class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
				<span class="text-(--form-muted) text-sm">{translate(unit)}</span>
			</div>
		{/if}
	</div>
</div>
