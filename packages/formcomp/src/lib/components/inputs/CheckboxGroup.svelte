<script lang="ts">
	import type { QuestionOption } from '../../types.js';
	import { cn } from '../../utils.js';
	import { warningRing, controlBase } from '../../styles.js';
	import { useTranslate } from '../../i18n.js';
	import FieldLabel from './FieldLabel.svelte';

	interface Props {
		options: QuestionOption[];
		value?: string[];
		onchange?: (value: string[]) => void;
		name?: string;
		label?: string;
		tooltip?: string;
		warning?: boolean;
		class?: string;
		optionClass?: string;
	}

	let { options, value = $bindable([]), onchange, name = 'checkbox', label, tooltip, warning = false, class: className, optionClass }: Props = $props();

	const translate = useTranslate();

	function handleToggle(optionValue: string, exclusive?: boolean) {
		let next: string[];

		if (exclusive) {
			next = value.includes(optionValue) ? [] : [optionValue];
		} else {
			const exclusiveValues = options.filter((o) => o.exclusive).map((o) => o.value);
			const current = value.filter((v) => !exclusiveValues.includes(v));

			if (current.includes(optionValue)) {
				next = current.filter((v) => v !== optionValue);
			} else {
				next = [...current, optionValue];
			}
		}

		value = next;
		onchange?.(next);
	}
</script>

<fieldset class={className}>
	{#if label}
		<FieldLabel tag="legend" text={label} {tooltip} />
	{/if}
	<div class={cn('space-y-4 rounded-(--form-radius) p-1', warning && cn(warningRing, 'p-4'))}>
		{#each options as option (option.value)}
			{@const checked = value.includes(option.value)}
			{@const id = `${name}-${option.value}`}
			<div class={cn('flex items-start gap-3', optionClass)}>
				<input
					type="checkbox"
					{id}
					{name}
					value={option.value}
					{checked}
					onchange={() => handleToggle(option.value, option.exclusive)}
					class={cn(controlBase, 'mt-0.5')}
				/>
				<div class="space-y-0.5">
					<label for={id} class="font-medium text-sm cursor-pointer">{translate(option.label)}</label>
					{#if option.description}
						<p class="text-sm text-(--form-muted)">{translate(option.description)}</p>
					{/if}
				</div>
			</div>
		{/each}
	</div>
</fieldset>
