<script lang="ts">
	import { setContext, tick, type Snippet } from 'svelte';
	import type { FormConfig, FormStateController, TranslateFn, FormCallbacks, SubmitPayload } from '../../types.js';
	import { FORM_STATE_KEY, TRANSLATE_KEY } from '../../types.js';
	import { createFormState } from '../../state/form-state.svelte.js';
	import { validateStep, collectResponses, isStepVisible } from '../../validation/validator.js';
	import { validateConfig } from '../../validation/config-check.js';
	import { buildSubmitPayload } from '../../submission.js';
	import { cn } from '../../utils.js';
	import ProgressBar from '../layout/ProgressBar.svelte';
	import NavigationButtons from '../layout/NavigationButtons.svelte';
	import FormStep from './FormStep.svelte';
	import SummaryStep from './SummaryStep.svelte';

	interface Props {
		config: FormConfig;
		translate?: TranslateFn;
		state?: FormStateController;
		callbacks?: FormCallbacks;
		/** Custom success screen, rendered in place of the built-in one after a successful POST */
		success?: Snippet<[SubmitPayload, unknown]>;
	}

	let { config, translate: translateFn, state: externalState, callbacks, success }: Props = $props();

	// These are intentionally captured once at mount time — to swap configs at
	// runtime, re-create the component with {#key}.
	const formState = externalState ?? createFormState(config, { version: config.version });
	const settings = config.settings ?? {};
	const t = (key: string) => (translateFn ? translateFn(key) : key);

	let rootEl = $state<HTMLDivElement>();
	let warningGroupId = $state<string | null>(null);
	let warningMessage = $state<string | undefined>();
	let showingSummary = $state(false);
	let completed = $state(false); // onFormComplete fired for the current answers
	let submitState = $state<'idle' | 'submitting' | 'succeeded'>('idle');
	let submitError = $state<string | null>(null);
	let successPayload = $state<SubmitPayload | null>(null);
	let successResponse = $state<unknown>(null);
	let successText = $state<{ title: string; message: string } | null>(null);

	setContext(FORM_STATE_KEY, formState);
	if (translateFn) {
		setContext(TRANSLATE_KEY, translateFn);
	}

	if (import.meta.env?.DEV) {
		for (const warning of validateConfig(config)) {
			console.warn(`[formcomp] ${warning}`);
		}
	}

	const getResponse = (sid: string, qid: string) => formState.getResponse(sid, qid);

	const visibleSteps = $derived(config.steps.filter((s) => isStepVisible(s, getResponse)));
	const currentStep = $derived(config.steps[formState.currentStepIndex]);
	const currentVisibleIndex = $derived(
		currentStep ? visibleSteps.findIndex((s) => s.id === currentStep.id) : -1
	);
	const isFirstStep = $derived(currentVisibleIndex <= 0);
	const isLastStep = $derived(currentVisibleIndex === visibleSteps.length - 1);
	const canGoBack = $derived(settings.allowBackNavigation !== false);

	// A persisted step index can point at a step that current answers hide —
	// snap back to the nearest earlier visible step (or the first one). Runs
	// once at mount, before the first render.
	{
		const idx = formState.currentStepIndex;
		const step = config.steps[idx];
		if (step && !isStepVisible(step, getResponse)) {
			let target = config.steps.findIndex((s) => isStepVisible(s, getResponse));
			for (let i = idx - 1; i >= 0; i--) {
				if (isStepVisible(config.steps[i], getResponse)) {
					target = i;
					break;
				}
			}
			if (target >= 0) formState.goToStep(target);
		}
	}

	/** Scroll to the top of the form and move focus to the new step heading. */
	async function focusStepStart() {
		await tick();
		const heading = rootEl?.querySelector<HTMLHeadingElement>('h2[tabindex="-1"]');
		heading?.focus({ preventScroll: true });
		rootEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	function goTo(absoluteIndex: number) {
		warningGroupId = null;
		showingSummary = false;
		completed = false;
		submitError = null;
		const fromIndex = formState.currentStepIndex;
		formState.goToStep(absoluteIndex);
		callbacks?.onStepChange?.(fromIndex, absoluteIndex);
		focusStepStart();
	}

	function handleNext() {
		if (!currentStep) return;

		if (showingSummary) {
			submitForm();
			return;
		}

		const result = validateStep(currentStep, getResponse, currentStep.id);

		if (!result.isValid) {
			warningGroupId = result.firstIncompleteGroupId;
			warningMessage =
				result.reason === 'invalid'
					? (settings.invalidMessage ?? 'Please correct the highlighted answers in this section.')
					: settings.requiredMessage;
			if (warningGroupId) {
				const el = document.getElementById(`formcomp-group-${warningGroupId}`);
				el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
			return;
		}

		warningGroupId = null;

		if (isLastStep) {
			callbacks?.onStepComplete?.(currentStep.id, formState.currentStepIndex);
			if (settings.showSummary) {
				showingSummary = true;
				focusStepStart();
			} else {
				submitForm();
			}
		} else {
			callbacks?.onStepComplete?.(currentStep.id, formState.currentStepIndex);
			const next = visibleSteps[currentVisibleIndex + 1];
			goTo(config.steps.indexOf(next));
		}
	}

	async function submitForm() {
		if (submitState !== 'idle') return;

		if (!completed) {
			completed = true;
			callbacks?.onFormComplete?.(collectResponses(config, getResponse));
		}

		if (!config.submit) return;

		const payload = buildSubmitPayload(config, getResponse, t);
		submitState = 'submitting';
		submitError = null;

		try {
			const res = await fetch(config.submit.url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...config.submit.headers },
				body: JSON.stringify(payload)
			});

			let data: Record<string, unknown> | null = null;
			try {
				data = await res.json();
			} catch {
				// non-JSON responses are fine
			}

			if (!res.ok) {
				// Show the server's error message when it sends one; otherwise the configured fallback
				submitState = 'idle';
				submitError =
					typeof data?.message === 'string'
						? data.message
						: t(settings.submitErrorMessage ?? 'Something went wrong while submitting. Please try again.');
				callbacks?.onSubmitError?.(new Error(`Request failed (${res.status})`));
				return;
			}

			callbacks?.onSubmitSuccess?.(payload, data);

			// A subscription/results page can take over entirely; the server's
			// redirectUrl wins over the config's successUrl.
			const redirect =
				(typeof data?.redirectUrl === 'string' && data.redirectUrl) || config.submit.successUrl;
			if (redirect) {
				window.location.assign(redirect);
				return;
			}

			successPayload = payload;
			successResponse = data;
			successText = {
				title: typeof data?.title === 'string' ? data.title : t(settings.successTitle ?? 'Thank you!'),
				message:
					typeof data?.message === 'string'
						? data.message
						: t(settings.successMessage ?? 'Your answers have been submitted.')
			};
			submitState = 'succeeded';
			focusStepStart();
		} catch (error) {
			// Network failure — don't surface browser-internal messages to the user
			submitState = 'idle';
			submitError = t(settings.submitErrorMessage ?? 'Something went wrong while submitting. Please try again.');
			callbacks?.onSubmitError?.(error);
		}
	}

	function handleBack() {
		if (showingSummary) {
			showingSummary = false;
			completed = false;
			submitError = null;
			focusStepStart();
			return;
		}
		if (isFirstStep) return;
		const prev = visibleSteps[currentVisibleIndex - 1];
		goTo(config.steps.indexOf(prev));
	}

	function handleStepClick(visibleIndex: number) {
		if (!canGoBack) return;
		if (showingSummary || visibleIndex < currentVisibleIndex) {
			goTo(config.steps.indexOf(visibleSteps[visibleIndex]));
		}
	}

	function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		handleNext();
	}

	const nextLabel = $derived(
		showingSummary || (isLastStep && !settings.showSummary)
			? (settings.submitLabel ?? 'Submit')
			: (settings.nextLabel ?? 'Next')
	);
</script>

<div bind:this={rootEl} class={cn('formcomp mx-auto max-w-4xl scroll-mt-4', config.class)}>
	{#if submitState === 'succeeded'}
		{#if success}
			{@render success(successPayload!, successResponse)}
		{:else}
			<div class="py-12 text-center">
				<svg class="mx-auto mb-4 size-12 text-(--form-accent)" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<circle cx="12" cy="12" r="10" />
					<path d="m9 12 2 2 4-4" />
				</svg>
				<h2 tabindex="-1" class="text-xl font-semibold tracking-tight outline-none">{successText?.title}</h2>
				<p class="mt-2 text-sm text-(--form-muted)">{successText?.message}</p>
			</div>
		{/if}
	{:else}
	{#if visibleSteps.length > 1 && settings.showProgress !== false}
		<ProgressBar
			steps={visibleSteps}
			currentIndex={showingSummary ? visibleSteps.length : currentVisibleIndex}
			onStepClick={handleStepClick}
			clickable={canGoBack}
		/>
	{/if}

	<form novalidate onsubmit={handleSubmit}>
		{#if showingSummary}
			<SummaryStep
				{config}
				heading={settings.summaryLabel}
				editLabel={settings.editLabel}
				onEdit={(i) => goTo(i)}
			/>
		{:else if currentStep}
			{#key currentStep.id}
				<FormStep stepConfig={currentStep} {warningGroupId} {warningMessage} />
			{/key}
		{/if}

		{#if submitError}
			<p role="alert" class="mt-6 rounded-(--form-radius) bg-(--form-error)/5 p-3 text-sm font-medium text-(--form-error) ring-1 ring-(--form-error)/20">
				{submitError}
			</p>
		{/if}

		<NavigationButtons
			showBack={(showingSummary || !isFirstStep) && canGoBack}
			showNext={true}
			submit={true}
			nextDisabled={submitState === 'submitting'}
			{nextLabel}
			backLabel={settings.backLabel ?? 'Back'}
			onback={handleBack}
		/>
	</form>
	{/if}
</div>
