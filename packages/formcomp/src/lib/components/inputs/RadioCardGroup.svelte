<script lang="ts">
	import type { QuestionOption } from '../../types.js';
	import { cn } from '../../utils.js';
	import { warningRing, optionFocus } from '../../styles.js';
	import { useTranslate } from '../../i18n.js';
	import FieldLabel from './FieldLabel.svelte';

	interface Props {
		options: QuestionOption[];
		value?: string | undefined;
		onchange?: (value: string) => void;
		name?: string;
		label?: string;
		tooltip?: string;
		warning?: boolean;
		columns?: 1 | 2 | 3;
		class?: string;
		optionClass?: string;
	}

	let { options, value = $bindable(), onchange, name = 'radio-card', label, tooltip, warning = false, columns = 3, class: className, optionClass }: Props = $props();

	const translate = useTranslate();

	function handleSelect(optionValue: string) {
		value = optionValue;
		onchange?.(optionValue);
	}

	const gridCols: Record<number, string> = {
		1: 'sm:grid-cols-1',
		2: 'sm:grid-cols-2',
		3: 'sm:grid-cols-3'
	};
</script>

<fieldset class={className}>
	{#if label}
		<FieldLabel tag="legend" text={label} {tooltip} />
	{/if}
	<div
		class={cn(
			'grid grid-cols-1 gap-3',
			gridCols[columns],
			warning && cn(warningRing, 'rounded-(--form-radius) p-2')
		)}
	>
		{#each options as option (option.value)}
			{@const checked = value === option.value}
			<label
				aria-label={translate(option.label)}
				title={option.description ? translate(option.description) : undefined}
				class={cn(
					'relative flex cursor-pointer rounded-(--form-radius) border bg-(--form-bg) p-4 shadow-sm transition-all hover:shadow-md',
					optionFocus,
					checked
						? 'border-(--form-accent) ring-2 ring-(--form-accent)'
						: 'border-(--form-border) hover:border-(--form-accent)/50',
					optionClass
				)}
			>
				<input
					type="radio"
					{name}
					value={option.value}
					checked={checked}
					onchange={() => handleSelect(option.value)}
					class="sr-only"
				/>
				<span class="flex flex-1 flex-col">
					<span class="text-sm font-medium">{translate(option.label)}</span>
					{#if option.description}
						<span class="mt-1 text-sm text-(--form-muted)">{translate(option.description)}</span>
					{/if}
				</span>
				<svg
					class={cn('size-5 text-(--form-accent) shrink-0', checked ? '' : 'invisible')}
					xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
					stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
					aria-hidden="true"
				>
					<circle cx="12" cy="12" r="10" />
					<path d="m9 12 2 2 4-4" />
				</svg>
			</label>
		{/each}
	</div>
</fieldset>
