<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { MultiStepForm, createFormState } from '$lib/index.js';
	import type { FormCallbacks } from '$lib/types.js';
	import { getExample } from '$examples';

	const example = $derived(getExample(page.params.slug ?? ''));

	const state = $derived(
		example
			? createFormState(example.config, {
					storageKey: `formcomp-example-${example.slug}`
				})
			: undefined
	);

	const callbacks: FormCallbacks = {
		onStepComplete(stepId, stepIndex) {
			console.log(`Step completed: ${stepId} (index: ${stepIndex})`);
		},
		onStepChange(from, to) {
			console.log(`Step changed: ${from} → ${to}`);
		},
		onFormComplete(allResponses) {
			console.log('Form completed!', allResponses);
			alert('Form submitted — check the console for the response payload.');
		}
	};
</script>

<svelte:head>
	<title>{example ? example.title : 'Example not found'} — formComp</title>
</svelte:head>

<div class="min-h-screen bg-background py-8 px-4 sm:px-6 lg:px-8">
	<div class="mx-auto max-w-4xl">
		<a href={resolve('/examples')} class="text-sm text-muted-foreground hover:text-foreground">
			← All examples
		</a>

		{#if example && state}
			<div class="text-center my-6">
				<h1 class="text-3xl font-bold tracking-tight">{example.title}</h1>
				<p class="mt-2 text-muted-foreground">{example.description}</p>
			</div>

			{#key example.slug}
				<MultiStepForm config={example.config} {state} {callbacks} />
			{/key}
		{:else}
			<div class="mt-10 text-center">
				<h1 class="text-2xl font-semibold">Example not found</h1>
				<p class="mt-2 text-muted-foreground">
					No example with slug <code>{page.params.slug}</code>.
				</p>
			</div>
		{/if}
	</div>
</div>
