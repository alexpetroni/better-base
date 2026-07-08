<script lang="ts">
	import type { QuestionOption } from '../../types.js';
	import { cn } from '../../utils.js';
	import { inputBase, warningField } from '../../styles.js';
	import { useTranslate } from '../../i18n.js';
	import FieldLabel from './FieldLabel.svelte';

	interface Props {
		options: QuestionOption[];
		value?: string | undefined;
		onchange?: (value: string | undefined) => void;
		name?: string;
		label?: string;
		tooltip?: string;
		placeholder?: string;
		warning?: boolean;
		class?: string;
	}

	let { options, value = $bindable(), onchange, name = 'select', label, tooltip, placeholder, warning = false, class: className }: Props = $props();

	const translate = useTranslate();

	function handleChange(e: Event) {
		const selected = (e.target as HTMLSelectElement).value;
		value = selected === '' ? undefined : selected;
		onchange?.(value);
	}
</script>

<div class={cn('space-y-2', className)}>
	{#if label}
		<FieldLabel forId={name} text={label} {tooltip} />
	{/if}
	<select
		{name}
		id={name}
		value={value ?? ''}
		onchange={handleChange}
		class={cn(inputBase, 'cursor-pointer', !value && 'text-(--form-muted)', warning && warningField)}
	>
		<option value="">{placeholder ? translate(placeholder) : '—'}</option>
		{#each options as option (option.value)}
			<option value={option.value}>{translate(option.label)}</option>
		{/each}
	</select>
</div>
