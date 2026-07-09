<script lang="ts">
	import { formatDate } from '$lib/util/date';
	import { createFormState, MultiStepForm, validateConfig, type FormConfig } from 'formcomp';
	import 'formcomp/theme.css';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { validateFormSchema, validateScoringConfig, type ScoringConfig } from '$lib/modules/quiz';

	let { data, form } = $props();

	// Failed saves echo the submitted JSON back so edits are never lost;
	// otherwise the textareas start from the stored config. Actions do a full
	// page reload (no enhance), so state re-initializes after every save.
	let formSchemaText = $state('');
	let scoringText = $state('');
	$effect.pre(() => {
		formSchemaText = form?.formSchemaText || JSON.stringify(data.quiz.formSchema, null, 2);
		scoringText = form?.scoringText || JSON.stringify(data.quiz.scoring, null, 2);
	});

	// Snapshot of the textarea config taken when the preview is toggled on —
	// typing afterwards doesn't churn the mounted form; re-toggle to refresh.
	let preview = $state<{ config: FormConfig; nonce: number } | null>(null);
	let previewNonce = 0;

	interface Parsed {
		config: FormConfig | null;
		scoring: ScoringConfig | null;
		problems: string[];
	}

	// Live validation of the CURRENT textarea contents: JSON syntax, this
	// project's structural + scoring rules, plus formcomp's own config checks.
	const parsed: Parsed = $derived.by(() => {
		const problems: string[] = [];
		let config: FormConfig | null = null;
		let scoring: ScoringConfig | null = null;
		try {
			config = JSON.parse(formSchemaText);
		} catch (e) {
			problems.push(`form_schema: ${(e as Error).message}`);
		}
		try {
			scoring = JSON.parse(scoringText);
		} catch (e) {
			problems.push(`scoring: ${(e as Error).message}`);
		}
		if (config) {
			const structural = validateFormSchema(config);
			problems.push(...structural);
			if (structural.length === 0) {
				problems.push(...validateConfig(config));
				if (scoring) problems.push(...validateScoringConfig(config, scoring));
			}
		}
		return { config, scoring, problems };
	});

	const errorMessages: Record<string, () => string> = {
		'json-form': m.admin_quiz_err_json_form,
		'json-scoring': m.admin_quiz_err_json_scoring,
		'invalid-form-schema': m.admin_quiz_err_form_schema,
		'invalid-scoring': m.admin_quiz_err_scoring,
		'invalid-title': m.admin_article_err_invalid_title,
		'invalid-slug': m.admin_quiz_err_slug,
		'unknown-pillar': m.admin_quiz_err_pillar,
		'not-publishable': m.admin_quiz_err_not_publishable
	};
</script>

<svelte:head>
	<title>{data.quiz.title} · {m.admin_nav_quizzes()}</title>
</svelte:head>

<div class="mb-4 flex items-center gap-3">
	<h1 class="grow truncate text-2xl font-bold">{data.quiz.title}</h1>
	<span
		data-testid="quiz-editor-status"
		class="rounded px-2 py-0.5 text-xs font-semibold
			{data.quiz.status === 'published'
			? 'bg-green-100 text-green-800'
			: 'bg-(--color-brand-soft) text-(--color-ink)'}"
	>
		{data.quiz.status === 'published'
			? m.admin_article_status_published()
			: m.admin_article_status_draft()}
	</span>
	{#if data.quiz.status === 'published'}
		<a
			href={resolve('/(public)/quiz/[slug]', { slug: data.quiz.slug })}
			target="_blank"
			data-testid="quiz-view-public"
			class="text-sm text-(--color-brand) hover:underline"
		>
			{m.admin_quiz_view_public()}
		</a>
	{/if}
</div>

{#if form?.saved}
	<p data-testid="quiz-editor-saved" class="mb-4 rounded bg-green-50 p-3 text-sm text-green-800">
		{m.admin_quiz_saved()}
	</p>
{:else if form?.error}
	<p data-testid="quiz-editor-error" class="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
		{(errorMessages[form.error] ?? (() => form.error))()}
		{#if form.detail}<span class="block opacity-80">{form.detail}</span>{/if}
	</p>
{/if}

<form method="POST" action="?/save" data-testid="quiz-editor">
	<div class="mb-4 grid gap-4 sm:grid-cols-2">
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_quiz_field_title()}</span>
			<input
				type="text"
				name="title"
				required
				value={data.quiz.title}
				data-testid="quiz-editor-title"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2"
			/>
		</label>
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_quiz_field_slug()}</span>
			<input
				type="text"
				name="slug"
				required
				value={data.quiz.slug}
				data-testid="quiz-editor-slug"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2 font-mono text-sm"
			/>
		</label>
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_quiz_field_pillar()}</span>
			<select
				name="pillar"
				data-testid="quiz-editor-pillar"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2"
			>
				<option value="" selected={data.pillarSlug === null}>
					{m.admin_quiz_pillar_none()}
				</option>
				{#each data.sitePillars as pillar (pillar.slug)}
					<option value={pillar.slug} selected={data.pillarSlug === pillar.slug}>
						{pillar.name}
					</option>
				{/each}
			</select>
		</label>
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_quiz_field_template()}</span>
			<select
				name="resultTemplateKey"
				data-testid="quiz-editor-template"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2"
			>
				{#each data.templateKeys as key (key)}
					<option value={key} selected={data.quiz.resultTemplateKey === key}>{key}</option>
				{/each}
			</select>
		</label>
	</div>

	<label class="mb-4 block">
		<span class="mb-1 block text-sm font-medium">{m.admin_quiz_field_intro()}</span>
		<textarea
			name="introMd"
			rows="3"
			data-testid="quiz-editor-intro"
			class="w-full rounded border border-(--color-brand-soft) px-3 py-2"
			>{data.quiz.introMd}</textarea
		>
	</label>

	<div class="mb-2 grid gap-4 lg:grid-cols-2">
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_quiz_field_form_schema()}</span>
			<textarea
				name="formSchema"
				rows="18"
				spellcheck="false"
				data-testid="quiz-editor-form-schema"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2 font-mono text-xs"
				bind:value={formSchemaText}></textarea>
		</label>
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_quiz_field_scoring()}</span>
			<textarea
				name="scoring"
				rows="18"
				spellcheck="false"
				data-testid="quiz-editor-scoring"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2 font-mono text-xs"
				bind:value={scoringText}></textarea>
		</label>
	</div>

	{#if parsed.problems.length > 0}
		<ul
			data-testid="quiz-editor-problems"
			class="mb-4 list-inside list-disc rounded bg-amber-50 p-3 text-sm text-amber-900"
		>
			{#each parsed.problems as problem, i (i)}
				<li>{problem}</li>
			{/each}
		</ul>
	{:else}
		<p data-testid="quiz-editor-valid" class="mb-4 text-sm text-green-700">
			{m.admin_quiz_config_valid()}
		</p>
	{/if}

	<div class="mb-8 flex flex-wrap items-center gap-2">
		<button
			type="submit"
			data-testid="quiz-editor-save"
			class="rounded bg-(--color-brand) px-4 py-2 font-semibold text-white hover:opacity-90"
		>
			{m.admin_quiz_save()}
		</button>
		{#if data.quiz.status === 'draft'}
			<button
				type="submit"
				formaction="?/publish"
				data-testid="quiz-editor-publish"
				class="rounded bg-green-700 px-4 py-2 font-semibold text-white hover:opacity-90"
			>
				{m.admin_quiz_publish()}
			</button>
		{:else}
			<button
				type="submit"
				formaction="?/unpublish"
				data-testid="quiz-editor-unpublish"
				class="rounded bg-(--color-brand-soft) px-4 py-2 font-semibold hover:opacity-90"
			>
				{m.admin_quiz_unpublish()}
			</button>
		{/if}
		<button
			type="button"
			data-testid="quiz-editor-toggle-preview"
			class="ml-auto rounded border border-(--color-brand-soft) px-4 py-2 text-sm hover:bg-(--color-brand-soft)/40"
			onclick={() => {
				preview =
					preview || !parsed.config ? null : { config: parsed.config, nonce: ++previewNonce };
			}}
			disabled={preview === null && parsed.config === null}
		>
			{preview ? m.admin_quiz_hide_preview() : m.admin_quiz_show_preview()}
		</button>
	</div>
</form>

{#if preview}
	<section
		data-testid="quiz-editor-preview"
		class="mb-10 rounded-xl border-2 border-dashed border-(--color-brand-soft) p-6"
	>
		<h2 class="mb-4 text-lg font-semibold">{m.admin_quiz_preview_heading()}</h2>
		{#key preview.nonce}
			<div class="formcomp">
				<MultiStepForm
					config={preview.config}
					state={createFormState(preview.config, { persist: false })}
				/>
			</div>
		{/key}
	</section>
{/if}

<section>
	<h2 class="mb-3 text-lg font-semibold">{m.admin_quiz_results_heading()}</h2>
	{#if data.results.length === 0}
		<p data-testid="quiz-results-empty" class="text-sm text-(--color-ink)/70">
			{m.admin_quiz_results_empty()}
		</p>
	{:else}
		<table
			data-testid="quiz-results-table"
			class="w-full rounded-lg border border-(--color-brand-soft) bg-white text-sm"
		>
			<thead>
				<tr class="border-b border-(--color-brand-soft) text-left">
					<th class="px-3 py-2">{m.admin_quiz_results_col_date()}</th>
					<th class="px-3 py-2">{m.admin_quiz_results_col_score()}</th>
					<th class="px-3 py-2">{m.admin_quiz_results_col_band()}</th>
					<th class="px-3 py-2">{m.admin_quiz_results_col_email()}</th>
				</tr>
			</thead>
			<tbody>
				{#each data.results as row (row.result.id)}
					<tr data-testid="quiz-result-row" class="border-b border-(--color-brand-soft)/50">
						<td class="px-3 py-2">{formatDate(row.result.createdAt, 'medium-time')}</td>
						<td class="px-3 py-2">{row.result.score}</td>
						<td class="px-3 py-2">{row.result.profile.band.label}</td>
						<td class="px-3 py-2">{row.email ?? '—'}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>
