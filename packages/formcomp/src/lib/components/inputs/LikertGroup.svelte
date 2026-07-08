<script lang="ts">
	import { getContext } from 'svelte';
	import {
		FORM_STATE_KEY, STEP_ID_KEY,
		type FormStateAdapter, type Question
	} from '../../types.js';
	import { cn } from '../../utils.js';
	import { warningRing, optionFocus } from '../../styles.js';
	import { useTranslate } from '../../i18n.js';

	interface Props {
		questions: Question[];
		warning?: boolean;
		class?: string;
	}

	let { questions, warning = false, class: className }: Props = $props();

	const state = getContext<FormStateAdapter>(FORM_STATE_KEY);
	const stepId = getContext<string>(STEP_ID_KEY);

	const translate = useTranslate();

	const scaleOptions = $derived(questions[0]?.options ?? []);

	function getQuestionValue(questionId: string): string | undefined {
		return state.getResponse(stepId, questionId) as string | undefined;
	}

	function setQuestionValue(questionId: string, value: string) {
		state.setResponse(stepId, questionId, value);
	}
</script>

<div
	class={cn(
		'space-y-3 rounded-(--form-radius) p-1',
		warning && cn(warningRing, 'p-4'),
		className
	)}
>
	<!-- Scale header -->
	{#if scaleOptions.length > 0}
		<div class="hidden sm:grid sm:gap-2" style="grid-template-columns: 1fr repeat({scaleOptions.length}, minmax(0, 1fr))">
			<div></div>
			{#each scaleOptions as option (option.value)}
				<div class="text-center text-xs text-(--form-muted) font-medium">{translate(option.label)}</div>
			{/each}
		</div>
	{/if}

	<!-- Question rows -->
	{#each questions as question (question.id)}
		{@const currentValue = getQuestionValue(question.id)}
		<div class="sm:grid sm:gap-2 sm:items-center border-b border-(--form-border) pb-3 last:border-0 last:pb-0" style="grid-template-columns: 1fr repeat({scaleOptions.length}, minmax(0, 1fr))">
			<div class="text-sm mb-2 sm:mb-0">{translate(question.label)}</div>
			<div class="flex flex-wrap gap-2 sm:contents">
				{#each scaleOptions as option (option.value)}
					{@const selected = currentValue === option.value}
					<label
						class={cn(
							'flex cursor-pointer items-center justify-center rounded-(--form-radius) px-3 py-2 text-sm font-medium border transition-all sm:flex-1',
							optionFocus,
							selected
								? 'bg-(--form-accent) text-(--form-accent-foreground) border-(--form-accent)'
								: 'border-(--form-border) bg-(--form-bg) hover:bg-(--form-accent)/10',
							question.optionClass
						)}
					>
						<input
							type="radio"
							name={question.id}
							value={option.value}
							checked={selected}
							onchange={() => setQuestionValue(question.id, option.value)}
							class="sr-only"
						/>
						<span class="sm:hidden">{translate(option.label)}</span>
						<span class="hidden sm:inline">&bull;</span>
					</label>
				{/each}
			</div>
		</div>
	{/each}
</div>
