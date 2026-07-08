<script lang="ts">
	import { getContext } from 'svelte';
	import {
		FORM_STATE_KEY,
		type FormStateAdapter, type FormConfig
	} from '../../types.js';
	import { evaluateCondition } from '../../conditions/evaluator.js';
	import { isStepVisible } from '../../validation/validator.js';
	import { formatAnswer } from '../../format.js';
	import { useTranslate } from '../../i18n.js';

	interface Props {
		config: FormConfig;
		heading?: string;
		editLabel?: string;
		/** Called with the absolute index (into config.steps) of the step to edit */
		onEdit?: (stepIndex: number) => void;
	}

	let { config, heading = 'Review your answers', editLabel = 'Edit', onEdit }: Props = $props();

	const state = getContext<FormStateAdapter>(FORM_STATE_KEY);
	const translate = useTranslate();

	const getResponse = (sid: string, qid: string) => state.getResponse(sid, qid);
</script>

<div class="space-y-8">
	<div class="mb-6">
		<h2 tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">{translate(heading)}</h2>
	</div>

	{#each config.steps as step, stepIndex (step.id)}
		{#if isStepVisible(step, getResponse)}
			<section class="rounded-(--form-radius) border border-(--form-border) p-4">
				<div class="mb-3 flex items-center justify-between gap-4">
					<h3 class="text-sm font-semibold tracking-tight">{translate(step.label)}</h3>
					<button
						type="button"
						onclick={() => onEdit?.(stepIndex)}
						class="text-sm font-medium text-(--form-accent) underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--form-accent)/40 rounded-sm"
					>
						{translate(editLabel)}
					</button>
				</div>
				<dl class="space-y-2">
					{#each step.groups as group (group.id)}
						{#if !group.condition || evaluateCondition(group.condition, getResponse, step.id)}
							{#each group.questions as question (question.id)}
								{#if !question.condition || evaluateCondition(question.condition, getResponse, step.id)}
									<div class="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
										<dt class="text-sm text-(--form-muted)">{translate(question.label)}</dt>
										<dd class="text-sm">{formatAnswer(question, getResponse(step.id, question.id), translate)}</dd>
									</div>
								{/if}
							{/each}
						{/if}
					{/each}
				</dl>
			</section>
		{/if}
	{/each}
</div>
