<script lang="ts">
	import { cn } from '../../utils.js';
	import { inputBase, warningField } from '../../styles.js';
	import { useTranslate } from '../../i18n.js';
	import FieldLabel from './FieldLabel.svelte';

	interface Props {
		value?: string | undefined;
		onchange?: (value: string) => void;
		name?: string;
		label?: string;
		tooltip?: string;
		step?: number;
		placeholder?: string;
		warning?: boolean;
		class?: string;
	}

	let { value = $bindable(), onchange, name = 'time', label, tooltip, step = 900, placeholder, warning = false, class: className }: Props = $props();

	const translate = useTranslate();

	function roundToStep(timeStr: string): string {
		if (!timeStr || step <= 0) return timeStr;
		const [h, m] = timeStr.split(':').map(Number);
		const stepMinutes = Math.floor(step / 60);
		if (stepMinutes <= 0) return timeStr;
		const rounded = Math.round(m / stepMinutes) * stepMinutes;
		const finalM = rounded % 60;
		const extraH = Math.floor(rounded / 60);
		const finalH = (h + extraH) % 24;
		return `${String(finalH).padStart(2, '0')}:${String(finalM).padStart(2, '0')}`;
	}

	function handleChange(e: Event) {
		const input = e.target as HTMLInputElement;
		const rounded = roundToStep(input.value);
		value = rounded;
		input.value = rounded;
		onchange?.(rounded);
	}
</script>

<div class={cn('space-y-2', className)}>
	{#if label}
		<FieldLabel forId={name} text={label} {tooltip} />
	{/if}
	<input
		type="time"
		{name}
		id={name}
		{step}
		value={value ?? ''}
		{placeholder}
		onchange={handleChange}
		class={cn(inputBase, warning && warningField)}
	/>
</div>
