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
		rows?: number;
		warning?: boolean;
		class?: string;
	}

	let { value = $bindable(), onchange, name = 'textarea', label, tooltip, placeholder, rows = 4, warning = false, class: className }: Props = $props();

	const translate = useTranslate();

	function handleInput(e: Event) {
		const el = e.target as HTMLTextAreaElement;
		value = el.value;
		onchange?.(el.value);
	}
</script>

<div class={cn('space-y-2', className)}>
	{#if label}
		<FieldLabel forId={name} text={label} {tooltip} />
	{/if}
	<textarea
		{name}
		id={name}
		{rows}
		{placeholder}
		value={value ?? ''}
		oninput={handleInput}
		class={cn(inputBase, 'min-h-16 resize-y', warning && warningField)}
	></textarea>
</div>
