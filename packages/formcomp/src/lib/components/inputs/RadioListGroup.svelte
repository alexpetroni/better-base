<script lang="ts">
	import type { QuestionOption } from '../../types.js';
	import { cn } from '../../utils.js';
	import { warningRing, controlBase } from '../../styles.js';
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
		class?: string;
		optionClass?: string;
	}

	let { options, value = $bindable(), onchange, name = 'radio', label, tooltip, warning = false, class: className, optionClass }: Props = $props();

	const translate = useTranslate();

	function handleChange(v: string) {
		value = v;
		onchange?.(v);
	}
</script>

<fieldset class={className}>
	{#if label}
		<FieldLabel tag="legend" text={label} {tooltip} />
	{/if}
	<div class={cn('rounded-(--form-radius) p-1', warning && cn(warningRing, 'p-4'))} role="radiogroup">
		{#each options as option (option.value)}
			{@const id = `${name}-${option.value}`}
			<div class={cn('flex items-start gap-3 py-1', optionClass)}>
				<input
					type="radio"
					{id}
					{name}
					value={option.value}
					checked={value === option.value}
					onchange={() => handleChange(option.value)}
					class={cn(controlBase, 'mt-1')}
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
