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
		placeholder?: string;
		type?: 'text' | 'email' | 'url';
		warning?: boolean;
		class?: string;
	}

	let { value = $bindable(), onchange, name = 'text', label, tooltip, placeholder, type = 'text', warning = false, class: className }: Props = $props();

	const translate = useTranslate();

	function handleInput(e: Event) {
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
		{type}
		{name}
		id={name}
		value={value ?? ''}
		{placeholder}
		oninput={handleInput}
		class={cn(inputBase, warning && warningField)}
	/>
</div>
