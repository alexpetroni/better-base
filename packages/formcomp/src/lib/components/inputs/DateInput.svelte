<script lang="ts">
	import { cn } from '../../utils.js';
	import { inputBase, warningField } from '../../styles.js';
	import FieldLabel from './FieldLabel.svelte';

	interface Props {
		/** ISO date string (YYYY-MM-DD) */
		value?: string | undefined;
		onchange?: (value: string) => void;
		name?: string;
		label?: string;
		tooltip?: string;
		warning?: boolean;
		class?: string;
	}

	let { value = $bindable(), onchange, name = 'date', label, tooltip, warning = false, class: className }: Props = $props();

	function handleChange(e: Event) {
		const input = e.target as HTMLInputElement;
		value = input.value;
		onchange?.(input.value);
	}
</script>

<div class={cn('space-y-2', className)}>
	{#if label}
		<FieldLabel forId={name} text={label} {tooltip} />
	{/if}
	<input
		type="date"
		{name}
		id={name}
		value={value ?? ''}
		onchange={handleChange}
		class={cn(inputBase, warning && warningField)}
	/>
</div>
