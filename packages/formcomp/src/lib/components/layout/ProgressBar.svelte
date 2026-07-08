<script lang="ts">
	import type { StepConfig } from '../../types.js';
	import { useTranslate } from '../../i18n.js';

	interface Props {
		steps: StepConfig[];
		currentIndex: number;
		onStepClick?: (index: number) => void;
		/** When false, completed steps are not clickable. Default: true. */
		clickable?: boolean;
	}

	let { steps, currentIndex, onStepClick, clickable = true }: Props = $props();

	const translate = useTranslate();
</script>

<nav aria-label="Progress" class="mb-8">
	<!-- On small screens the step labels collapse to numbers, so spell out where we are -->
	{#if steps[currentIndex]}
		<p class="sm:hidden mb-2 text-sm text-(--form-muted)">
			{currentIndex + 1} / {steps.length} · <span class="font-medium text-(--form-fg)">{translate(steps[currentIndex].label)}</span>
		</p>
	{/if}
	<ol role="list" class="flex items-center gap-2 overflow-x-auto">
		{#each steps as step, i (step.id)}
			{@const isCompleted = i < currentIndex}
			{@const isCurrent = i === currentIndex}
			<li class="flex items-center gap-2">
				{#if isCompleted && clickable}
					<button
						type="button"
						onclick={() => onStepClick?.(i)}
						class="group flex items-center gap-2 rounded-full bg-(--form-accent) px-3 py-1.5 text-sm font-medium text-(--form-accent-foreground) transition-colors hover:bg-(--form-accent)/80"
					>
						<svg class="size-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M20 6 9 17l-5-5" />
						</svg>
						<span class="hidden sm:inline">{translate(step.label)}</span>
					</button>
				{:else if isCompleted}
					<span class="flex items-center gap-2 rounded-full bg-(--form-accent) px-3 py-1.5 text-sm font-medium text-(--form-accent-foreground)">
						<svg class="size-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M20 6 9 17l-5-5" />
						</svg>
						<span class="hidden sm:inline">{translate(step.label)}</span>
					</span>
				{:else if isCurrent}
					<span
						class="flex items-center gap-2 rounded-full border-2 border-(--form-accent) px-3 py-1.5 text-sm font-medium text-(--form-accent)"
						aria-current="step"
					>
						<span class="flex size-5 items-center justify-center rounded-full bg-(--form-accent) text-xs text-(--form-accent-foreground)">
							{i + 1}
						</span>
						<span class="hidden sm:inline">{translate(step.label)}</span>
					</span>
				{:else}
					<span class="flex items-center gap-2 rounded-full border border-(--form-border) px-3 py-1.5 text-sm font-medium text-(--form-muted)">
						<span class="flex size-5 items-center justify-center rounded-full border border-(--form-border) text-xs">
							{i + 1}
						</span>
						<span class="hidden sm:inline">{translate(step.label)}</span>
					</span>
				{/if}

				{#if i < steps.length - 1}
					<svg class="size-4 text-(--form-muted) shrink-0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="m9 18 6-6-6-6" />
					</svg>
				{/if}
			</li>
		{/each}
	</ol>
</nav>
