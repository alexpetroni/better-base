<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { slugify } from '$lib/modules/blog';
	import { Img, type ImageSources } from '$lib/modules/media';
	import MediaPicker from './MediaPicker.svelte';
	import type { LibraryImage } from './+page.server';

	let { data, form } = $props();

	// The form intentionally captures the article's INITIAL values — it is an
	// editing buffer, not a live view of server data.
	// svelte-ignore state_referenced_locally
	let draft = $state({
		title: data.article.title,
		slug: data.article.slug,
		excerpt: data.article.excerpt,
		bodyMd: data.article.bodyMd,
		seoTitle: data.article.seoTitle ?? '',
		seoDescription: data.article.seoDescription ?? '',
		coverMediaId: data.article.coverMediaId ?? '',
		coverThumb: data.coverThumb as ImageSources | null,
		pillars: data.pillarSlugs
	});
	let slugEdited = $state(false);

	let bodyTextarea = $state<HTMLTextAreaElement | null>(null);
	let picker = $state<'closed' | 'cover' | 'insert'>('closed');
	let showPreview = $state(false);
	let saved = $state(false);

	function onTitleInput() {
		if (!slugEdited) draft.slug = slugify(draft.title);
	}

	function insertAtCursor(snippet: string) {
		const el = bodyTextarea;
		const at = el?.selectionStart ?? draft.bodyMd.length;
		draft.bodyMd = `${draft.bodyMd.slice(0, at)}${snippet}${draft.bodyMd.slice(el?.selectionEnd ?? at)}`;
	}

	function onPick(item: LibraryImage) {
		if (picker === 'cover') {
			draft.coverMediaId = item.id;
			draft.coverThumb = item.thumb;
		} else if (picker === 'insert') {
			insertAtCursor(`![${item.alt}](media:${item.key})`);
		}
		picker = 'closed';
	}

	function errorMessage(code: string, detail: string): string {
		if (code === 'invalid-title') return m.admin_article_err_invalid_title();
		if (code === 'invalid-slug') return m.admin_article_err_invalid_slug();
		if (code === 'unknown-pillar') return m.admin_article_err_unknown_pillar({ detail });
		return m.admin_article_err_not_found();
	}
</script>

<svelte:head>
	<title>{data.article.title} · {m.admin_nav_articles()}</title>
</svelte:head>

<div class="mb-4 flex items-center gap-3">
	<a href={resolve('/admin/articles')} class="text-sm text-(--color-brand) hover:underline">
		← {m.admin_nav_articles()}
	</a>
	<span
		data-testid="editor-status"
		class="rounded px-2 py-0.5 text-xs font-semibold
			{data.article.status === 'published'
			? 'bg-green-100 text-green-800'
			: 'bg-(--color-brand-soft) text-(--color-ink)'}"
	>
		{data.article.status === 'published'
			? m.admin_article_status_published()
			: m.admin_article_status_draft()}
	</span>
	{#if data.article.status === 'published'}
		<a
			href={resolve('/(public)/blog/[slug]', { slug: data.article.slug })}
			data-testid="editor-view-public"
			class="text-sm text-(--color-brand) hover:underline"
		>
			{m.admin_article_view_public()}
		</a>
	{/if}
</div>

{#if form?.error}
	<p data-testid="editor-error" class="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
		{errorMessage(form.error, form.detail ?? '')}
	</p>
{/if}

<form
	method="POST"
	action="?/save"
	use:enhance={({ action }) =>
		async ({ update, result }) => {
			await update({ reset: false });
			if (result.type === 'success') {
				if (action.search.includes('preview')) {
					showPreview = true;
				} else if (result.data?.slug) {
					// The server may have normalized/deduplicated the slug.
					draft.slug = String(result.data.slug);
					saved = true;
					setTimeout(() => (saved = false), 2500);
				}
			}
		}}
	class="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_18rem]"
>
	<div class="space-y-4">
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_article_title()}</span>
			<input
				type="text"
				name="title"
				required
				bind:value={draft.title}
				oninput={onTitleInput}
				data-testid="editor-title"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2 text-lg"
			/>
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_article_slug()}</span>
			<input
				type="text"
				name="slug"
				required
				bind:value={draft.slug}
				oninput={() => (slugEdited = true)}
				data-testid="editor-slug"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2 font-mono text-sm"
			/>
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_article_excerpt()}</span>
			<textarea
				name="excerpt"
				rows="2"
				bind:value={draft.excerpt}
				data-testid="editor-excerpt"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2"></textarea>
		</label>

		<div>
			<div class="mb-1 flex items-center justify-between">
				<span class="text-sm font-medium">{m.admin_article_body()}</span>
				<div class="flex gap-2">
					<button
						type="button"
						data-testid="editor-insert-image"
						class="rounded bg-(--color-brand-soft) px-3 py-1 text-sm hover:opacity-80"
						onclick={() => (picker = 'insert')}
					>
						{m.admin_article_insert_image()}
					</button>
					{#if showPreview}
						<button
							type="button"
							data-testid="editor-show-editor"
							class="rounded bg-(--color-brand-soft) px-3 py-1 text-sm hover:opacity-80"
							onclick={() => (showPreview = false)}
						>
							{m.admin_article_edit_md()}
						</button>
					{:else}
						<button
							type="submit"
							formaction="?/preview"
							data-testid="editor-show-preview"
							class="rounded bg-(--color-brand-soft) px-3 py-1 text-sm hover:opacity-80"
						>
							{m.admin_article_preview()}
						</button>
					{/if}
				</div>
			</div>
			<!-- The textarea stays in the DOM while previewing so bodyMd always posts. -->
			<textarea
				name="bodyMd"
				rows="18"
				bind:value={draft.bodyMd}
				bind:this={bodyTextarea}
				data-testid="editor-body"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2 font-mono text-sm
					{showPreview ? 'hidden' : ''}"></textarea>
			{#if showPreview}
				<div
					data-testid="editor-preview"
					class="prose max-w-none rounded border border-(--color-brand-soft) bg-white px-4 py-3"
				>
					<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized server-side by the markdown pipeline -->
					{@html form?.preview ?? ''}
				</div>
			{/if}
			<p class="mt-1 text-xs text-(--color-ink)/60">{m.admin_article_body_hint()}</p>
		</div>

		<div class="grid gap-4 sm:grid-cols-2">
			<label class="block">
				<span class="mb-1 block text-sm font-medium">{m.admin_article_seo_title()}</span>
				<input
					type="text"
					name="seoTitle"
					bind:value={draft.seoTitle}
					data-testid="editor-seo-title"
					class="w-full rounded border border-(--color-brand-soft) px-3 py-2"
				/>
			</label>
			<label class="block">
				<span class="mb-1 block text-sm font-medium">{m.admin_article_seo_description()}</span>
				<input
					type="text"
					name="seoDescription"
					bind:value={draft.seoDescription}
					data-testid="editor-seo-description"
					class="w-full rounded border border-(--color-brand-soft) px-3 py-2"
				/>
			</label>
		</div>
	</div>

	<aside class="space-y-6">
		<div class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
			<h2 class="mb-2 text-sm font-semibold">{m.admin_article_cover()}</h2>
			<input type="hidden" name="coverMediaId" value={draft.coverMediaId} />
			{#if draft.coverThumb}
				<Img
					image={draft.coverThumb}
					alt=""
					decorative
					class="mb-2 aspect-[8/5] w-full rounded bg-(--color-brand-soft)/20 object-cover"
				/>
			{:else}
				<p data-testid="editor-cover-none" class="mb-2 text-sm text-(--color-ink)/60">
					{m.admin_article_cover_none()}
				</p>
			{/if}
			<div class="flex gap-2">
				<button
					type="button"
					data-testid="editor-cover-pick"
					class="rounded bg-(--color-brand-soft) px-3 py-1 text-sm hover:opacity-80"
					onclick={() => (picker = 'cover')}
				>
					{m.admin_article_cover_pick()}
				</button>
				{#if draft.coverMediaId}
					<button
						type="button"
						data-testid="editor-cover-remove"
						class="rounded px-3 py-1 text-sm text-red-700 hover:bg-red-50"
						onclick={() => {
							draft.coverMediaId = '';
							draft.coverThumb = null;
						}}
					>
						{m.admin_article_cover_remove()}
					</button>
				{/if}
			</div>
		</div>

		<fieldset class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
			<legend class="px-1 text-sm font-semibold">{m.admin_article_pillars()}</legend>
			<ul class="space-y-1">
				{#each data.sitePillars as pillar (pillar.slug)}
					<li>
						<label class="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								name="pillars"
								value={pillar.slug}
								checked={draft.pillars.includes(pillar.slug)}
								data-testid="editor-pillar-{pillar.slug}"
							/>
							{pillar.name}
						</label>
					</li>
				{/each}
			</ul>
		</fieldset>

		<div class="space-y-2">
			<button
				type="submit"
				data-testid="editor-save"
				class="w-full rounded bg-(--color-brand) px-4 py-2 font-semibold text-white hover:opacity-90"
			>
				{m.admin_article_save()}
			</button>
			{#if data.article.status === 'published'}
				<button
					type="submit"
					formaction="?/unpublish"
					data-testid="editor-unpublish"
					class="w-full rounded border border-(--color-brand) px-4 py-2 font-semibold text-(--color-brand) hover:bg-(--color-brand-soft)/40"
				>
					{m.admin_article_unpublish()}
				</button>
			{:else}
				<button
					type="submit"
					formaction="?/publish"
					data-testid="editor-publish"
					class="w-full rounded bg-green-700 px-4 py-2 font-semibold text-white hover:opacity-90"
				>
					{m.admin_article_publish()}
				</button>
			{/if}
			{#if saved}
				<p data-testid="editor-saved" class="text-center text-sm text-green-700">
					{m.admin_article_saved()}
				</p>
			{/if}
		</div>
	</aside>
</form>

{#if picker !== 'closed'}
	<MediaPicker items={data.library} onpick={onPick} onclose={() => (picker = 'closed')} />
{/if}
