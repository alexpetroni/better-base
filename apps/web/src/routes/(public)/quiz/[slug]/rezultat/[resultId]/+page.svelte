<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import Seo from '$lib/components/Seo.svelte';
	import { canonicalUrl } from '$lib/seo';

	let { data, form } = $props();

	function percent(score: number, maxScore: number | null): number {
		if (!maxScore || maxScore <= 0) return 0;
		return Math.round(Math.min(100, Math.max(0, (score / maxScore) * 100)));
	}
</script>

<Seo
	title={m.quiz_result_title({ quiz: data.quizTitle })}
	description={m.quiz_seo_description({ title: data.quizTitle })}
	canonical={canonicalUrl(`/quiz/${data.quizSlug}`)}
	siteName={data.site.name}
/>

<article data-testid="quiz-result-page" class="mx-auto max-w-2xl">
	<p class="text-sm text-(--color-ink)/60">{data.quizTitle}</p>
	<h1 class="mb-6 text-3xl font-bold">{m.quiz_result_heading()}</h1>

	<section
		class="mb-8 rounded-xl border border-(--color-brand-soft) bg-(--color-brand-soft)/30 p-6"
	>
		<p class="mb-1 text-sm text-(--color-ink)/70" data-testid="result-score">
			{#if data.profile.maxScore !== null}
				{m.quiz_result_score({ score: data.profile.score, max: data.profile.maxScore })}
			{:else}
				{m.quiz_result_score_simple({ score: data.profile.score })}
			{/if}
		</p>
		<h2 class="mb-2 text-2xl font-bold text-(--color-brand)" data-testid="result-band">
			{data.profile.band.label}
		</h2>
		<p data-testid="result-advice">{data.profile.band.advice}</p>
	</section>

	{#if data.profile.dimensions.length > 0}
		<section class="mb-10">
			<h2 class="mb-4 text-lg font-semibold">{m.quiz_result_dimensions()}</h2>
			<ul class="space-y-3">
				{#each data.profile.dimensions as dim (dim.key)}
					<li data-testid="result-dimension" data-dimension={dim.key}>
						<div class="mb-1 flex justify-between text-sm">
							<span>{dim.label}</span>
							<span class="text-(--color-ink)/60">
								{dim.maxScore !== null ? `${dim.score} / ${dim.maxScore}` : dim.score}
							</span>
						</div>
						<div class="h-2 rounded bg-(--color-brand-soft)">
							<div
								class="h-2 rounded bg-(--color-brand)"
								style="width: {percent(dim.score, dim.maxScore)}%"
							></div>
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<section class="rounded-xl border border-(--color-brand-soft) p-6">
		{#if form?.sent}
			<p data-testid="result-email-sent" class="font-medium text-green-700">
				{m.quiz_email_sent()}
			</p>
		{:else}
			<h2 class="mb-1 text-lg font-semibold">{m.quiz_email_heading()}</h2>
			<p class="mb-4 text-sm text-(--color-ink)/70">{m.quiz_email_blurb()}</p>
			{#if data.claimed}
				<p class="mb-4 text-sm text-(--color-ink)/70" data-testid="result-already-claimed">
					{m.quiz_email_already()}
				</p>
			{/if}
			{#if form?.error}
				<p data-testid="result-email-error" class="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">
					{m.quiz_email_invalid()}
				</p>
			{/if}
			<form method="POST" action="?/email">
				<div class="mb-3 flex flex-col gap-2 sm:flex-row">
					<input
						type="text"
						name="name"
						data-testid="result-name"
						placeholder={m.quiz_email_name_placeholder()}
						class="rounded border border-(--color-brand-soft) px-3 py-2 sm:w-40"
					/>
					<input
						type="email"
						name="email"
						required
						data-testid="result-email"
						placeholder={m.newsletter_email_placeholder()}
						class="grow rounded border border-(--color-brand-soft) px-3 py-2"
					/>
				</div>
				<!-- GDPR: both marketing consents default UNTICKED and are optional;
				     the result email itself is transactional. -->
				<label class="mb-2 flex items-start gap-2 text-sm">
					<input
						type="checkbox"
						name="newsletter_consent"
						value="yes"
						data-testid="result-consent-newsletter"
						class="mt-0.5"
					/>
					<span>{m.newsletter_consent_label()}</span>
				</label>
				<label class="mb-4 flex items-start gap-2 text-sm">
					<input
						type="checkbox"
						name="profile_consent"
						value="yes"
						data-testid="result-consent-profile"
						class="mt-0.5"
					/>
					<span>{m.quiz_consent_profile_label()}</span>
				</label>
				<button
					type="submit"
					data-testid="result-email-submit"
					class="rounded bg-(--color-brand) px-4 py-2 font-semibold text-white hover:opacity-90"
				>
					{m.quiz_email_submit()}
				</button>
			</form>
		{/if}
	</section>

	<p class="mt-8">
		<a href={resolve('/')} class="text-(--color-brand) hover:underline">{m.error_back_home()}</a>
	</p>
</article>
