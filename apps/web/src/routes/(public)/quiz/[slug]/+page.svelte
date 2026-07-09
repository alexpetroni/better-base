<script lang="ts">
	import { createFormState, MultiStepForm, type FormConfig } from 'formcomp';
	import 'formcomp/theme.css';
	import { m } from '$lib/paraglide/messages';
	import Seo from '$lib/components/Seo.svelte';
	import { canonicalUrl } from '$lib/seo';

	let { data } = $props();

	// Stored schema + ro defaults for formcomp's built-in labels (a stored
	// settings value wins) + the submit endpoint. Config is captured at mount;
	// {#key} below re-creates the form when navigating between quizzes.
	const config: FormConfig = $derived({
		...data.quiz.formSchema,
		version: data.quiz.version,
		settings: {
			nextLabel: m.quiz_next(),
			backLabel: m.quiz_back(),
			submitLabel: m.quiz_submit(),
			requiredMessage: m.quiz_required(),
			invalidMessage: m.quiz_invalid(),
			submitErrorMessage: m.quiz_submit_error(),
			...data.quiz.formSchema.settings
		},
		submit: {
			url: `/quiz/${data.quiz.slug}/submit`,
			// Per-attempt idempotency token: a retried/replayed POST of the same
			// answers must not create a second result row (server dedupes on it).
			headers: { 'x-quiz-attempt': crypto.randomUUID() }
		}
	});
	const state = $derived(
		createFormState(config, { storageKey: `quiz-${data.quiz.slug}`, version: data.quiz.version })
	);
</script>

<Seo
	title={data.quiz.title}
	description={m.quiz_seo_description({ title: data.quiz.title })}
	canonical={canonicalUrl(`/quiz/${data.quiz.slug}`)}
	siteName={data.site.name}
/>

<article data-testid="quiz-page">
	<h1 class="mb-4 text-3xl font-bold">{data.quiz.title}</h1>
	{#if data.quiz.introHtml}
		<div class="prose mb-8 max-w-none" data-testid="quiz-intro">
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized by renderMarkdown -->
			{@html data.quiz.introHtml}
		</div>
	{/if}

	{#key data.quiz.slug}
		<div class="formcomp">
			<MultiStepForm {config} {state} />
		</div>
	{/key}
</article>
