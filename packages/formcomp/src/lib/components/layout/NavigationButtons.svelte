<script lang="ts">
	import { useTranslate } from '../../i18n.js';

	interface Props {
		showBack?: boolean;
		showNext?: boolean;
		nextLabel?: string;
		backLabel?: string;
		onback?: () => void;
		onnext?: () => void;
		/** Render the next button as type="submit" (for use inside a <form>); onnext is ignored. */
		submit?: boolean;
		/** Disable the next/submit button, e.g. while a submission is in flight. */
		nextDisabled?: boolean;
	}

	let { showBack = true, showNext = true, nextLabel = 'Next', backLabel = 'Back', onback, onnext, submit = false, nextDisabled = false }: Props = $props();

	const translate = useTranslate();

	const buttonBase =
		'inline-flex items-center gap-2 rounded-(--form-radius) px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--form-accent)/40 disabled:pointer-events-none disabled:opacity-50';
</script>

<div class="mt-8">
	<hr class="border-(--form-border)" />
	<div class="flex justify-between pt-6">
		<div>
			{#if showBack}
				<button
					type="button"
					onclick={onback}
					class="{buttonBase} border border-(--form-border) bg-(--form-bg) hover:bg-(--form-accent)/10"
				>
					<svg class="size-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="m12 19-7-7 7-7" /><path d="M19 12H5" />
					</svg>
					{translate(backLabel)}
				</button>
			{/if}
		</div>
		<div>
			{#if showNext}
				<button
					type={submit ? 'submit' : 'button'}
					onclick={submit ? undefined : onnext}
					disabled={nextDisabled}
					aria-busy={nextDisabled || undefined}
					class="{buttonBase} bg-(--form-accent) text-(--form-accent-foreground) hover:bg-(--form-accent)/85"
				>
					{translate(nextLabel)}
					<svg class="size-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
					</svg>
				</button>
			{/if}
		</div>
	</div>
</div>
