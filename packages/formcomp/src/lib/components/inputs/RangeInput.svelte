<script lang="ts">
	import type { RangeValue } from '../../types.js';
	import { cn } from '../../utils.js';
	import { inputBase, warningField } from '../../styles.js';
	import { useTranslate } from '../../i18n.js';
	import FieldLabel from './FieldLabel.svelte';

	interface Props {
		value?: RangeValue | undefined;
		onchange?: (value: RangeValue | undefined) => void;
		name?: string;
		label?: string;
		tooltip?: string;
		min?: number;
		max?: number;
		step?: number;
		unit?: string;
		/** Label above the lower field. Default: 'From'. */
		minLabel?: string;
		/** Label above the upper field. Default: 'To'. */
		maxLabel?: string;
		warning?: boolean;
		class?: string;
	}

	let {
		value = $bindable(),
		onchange,
		name = 'range',
		label,
		tooltip,
		min,
		max,
		step,
		unit,
		minLabel = 'From',
		maxLabel = 'To',
		warning = false,
		class: className
	}: Props = $props();

	const translate = useTranslate();

	function parseField(raw: string): number | undefined {
		if (raw === '') return undefined;
		let num = parseFloat(raw);
		if (isNaN(num)) return undefined;
		if (min !== undefined && num < min) num = min;
		if (max !== undefined && num > max) num = max;
		return num;
	}

	function handleChange(field: 'from' | 'to', e: Event) {
		const num = parseField((e.target as HTMLInputElement).value);
		const next: RangeValue = { ...value, [field]: num };
		if (next.from === undefined && next.to === undefined) {
			value = undefined;
		} else {
			value = next;
		}
		onchange?.(value);
	}
</script>

<fieldset class={className} aria-label={label ? undefined : name}>
	{#if label}
		<FieldLabel tag="legend" text={label} {tooltip} />
	{/if}
	<div class="grid grid-cols-2 gap-4">
		{#each [['from', minLabel], ['to', maxLabel]] as const as [field, fieldLabel] (field)}
			{@const id = `${name}-${field}`}
			<div class="space-y-1">
				<label for={id} class="text-xs font-medium text-(--form-muted)">{translate(fieldLabel)}</label>
				<div class="relative">
					<input
						type="number"
						name={id}
						{id}
						{min}
						{max}
						{step}
						value={value?.[field] ?? ''}
						onchange={(e) => handleChange(field, e)}
						class={cn(inputBase, unit && 'pr-12', warning && warningField)}
					/>
					{#if unit}
						<div class="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
							<span class="text-(--form-muted) text-sm">{translate(unit)}</span>
						</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</fieldset>
