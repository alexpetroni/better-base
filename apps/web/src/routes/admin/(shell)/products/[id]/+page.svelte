<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import { slugify } from '$lib/util/slug';
	import { Img, type ImageSources } from '$lib/modules/media';
	import { formatCents } from '$lib/util/money';
	import CoverField from '$lib/components/CoverField.svelte';
	import MediaPicker, { type LibraryImage } from '$lib/components/MediaPicker.svelte';
	import PillarChecklist from '$lib/components/PillarChecklist.svelte';

	let { data, form } = $props();

	// The editor buffer below intentionally captures INITIAL server data.
	// svelte-ignore state_referenced_locally
	const thumbById = new Map(data.library.map((item) => [item.id, item.thumb]));

	// The form intentionally captures the product's INITIAL values — it is an
	// editing buffer, not a live view of server data.
	// svelte-ignore state_referenced_locally
	let draft = $state({
		name: data.product.name,
		slug: data.product.slug,
		// Editable "49,90" string; parsed server-side into integer bani.
		price: formatCents(data.product.priceCents).split(' ')[0],
		stock: data.product.stock === null ? '' : String(data.product.stock),
		status: data.product.status,
		descriptionMd: data.product.descriptionMd,
		coverMediaId: data.product.coverMediaId ?? '',
		coverThumb: (data.product.coverMediaId
			? (thumbById.get(data.product.coverMediaId) ?? null)
			: null) as ImageSources | null,
		gallery: data.product.gallery.map((id) => ({ id, thumb: thumbById.get(id) ?? null })),
		pillars: data.pillarSlugs
	});
	let slugEdited = $state(false);
	let picker = $state<'closed' | 'cover' | 'gallery'>('closed');
	let saved = $state(false);

	const statusLabels: Record<string, () => string> = {
		draft: m.admin_product_status_draft,
		active: m.admin_product_status_active,
		archived: m.admin_product_status_archived
	};

	function onNameInput() {
		if (!slugEdited) draft.slug = slugify(draft.name);
	}

	function onPick(item: LibraryImage) {
		if (picker === 'cover') {
			draft.coverMediaId = item.id;
			draft.coverThumb = item.thumb;
		} else if (picker === 'gallery' && !draft.gallery.some((g) => g.id === item.id)) {
			draft.gallery.push({ id: item.id, thumb: item.thumb });
		}
		picker = 'closed';
	}

	function errorMessage(code: string, detail: string): string {
		if (code === 'invalid-name') return m.admin_product_err_name();
		if (code === 'invalid-slug') return m.admin_product_err_slug();
		if (code === 'invalid-price') return m.admin_product_err_price();
		if (code === 'invalid-stock') return m.admin_product_err_stock();
		if (code === 'unknown-pillar') return m.admin_product_err_pillar({ detail });
		return m.admin_product_err_not_found();
	}

	const isSynced = $derived(!!(data.product.stripeProductId && data.product.stripePriceId));
</script>

<svelte:head>
	<title>{data.product.name} · {m.admin_nav_products()}</title>
</svelte:head>

<div class="mb-4 flex items-center gap-3">
	<a href={resolve('/admin/products')} class="text-sm text-(--color-brand) hover:underline">
		← {m.admin_nav_products()}
	</a>
	<span
		data-testid="product-editor-status"
		class="rounded px-2 py-0.5 text-xs font-semibold
			{data.product.status === 'active'
			? 'bg-green-100 text-green-800'
			: 'bg-(--color-brand-soft) text-(--color-ink)'}"
	>
		{statusLabels[data.product.status]()}
	</span>
	<span
		data-testid="product-editor-sync"
		class="rounded px-2 py-0.5 text-xs
			{isSynced ? 'bg-blue-100 text-blue-800' : 'bg-(--color-brand-soft) text-(--color-ink)/70'}"
	>
		{isSynced ? m.admin_product_synced() : m.admin_product_not_synced()}
	</span>
	{#if data.product.status === 'active'}
		<a
			href={resolve('/(public)/magazin/[slug]', { slug: data.product.slug })}
			data-testid="product-editor-view-public"
			class="text-sm text-(--color-brand) hover:underline"
		>
			{m.admin_product_view_public()}
		</a>
	{/if}
</div>

{#if form?.error}
	<p data-testid="product-editor-error" class="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
		{errorMessage(form.error, form.detail ?? '')}
	</p>
{/if}
{#if form?.saved && form.syncError}
	<p
		data-testid="product-editor-sync-error"
		class="mb-4 rounded bg-amber-50 p-3 text-sm text-amber-800"
	>
		{m.admin_product_sync_failed({ detail: form.syncError })}
	</p>
{/if}

<form
	method="POST"
	action="?/save"
	use:enhance={() =>
		async ({ update, result }) => {
			await update({ reset: false });
			if (result.type === 'success' && result.data?.slug) {
				// The server may have normalized/deduplicated the slug.
				draft.slug = String(result.data.slug);
				saved = true;
				setTimeout(() => (saved = false), 2500);
			}
		}}
	class="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_18rem]"
>
	<div class="space-y-4">
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_product_name()}</span>
			<input
				type="text"
				name="name"
				required
				bind:value={draft.name}
				oninput={onNameInput}
				data-testid="product-editor-name"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2 text-lg"
			/>
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_product_slug()}</span>
			<input
				type="text"
				name="slug"
				required
				bind:value={draft.slug}
				oninput={() => (slugEdited = true)}
				data-testid="product-editor-slug"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2 font-mono text-sm"
			/>
		</label>

		<div class="grid gap-4 sm:grid-cols-3">
			<label class="block">
				<span class="mb-1 block text-sm font-medium">{m.admin_product_price()}</span>
				<input
					type="text"
					name="price"
					required
					inputmode="decimal"
					bind:value={draft.price}
					data-testid="product-editor-price"
					class="w-full rounded border border-(--color-brand-soft) px-3 py-2"
				/>
			</label>
			<label class="block">
				<span class="mb-1 block text-sm font-medium">{m.admin_product_stock()}</span>
				<input
					type="number"
					name="stock"
					min="0"
					step="1"
					bind:value={draft.stock}
					data-testid="product-editor-stock"
					class="w-full rounded border border-(--color-brand-soft) px-3 py-2"
				/>
			</label>
			<label class="block">
				<span class="mb-1 block text-sm font-medium">{m.admin_product_status()}</span>
				<select
					name="status"
					bind:value={draft.status}
					data-testid="product-editor-status-select"
					class="w-full rounded border border-(--color-brand-soft) px-3 py-2"
				>
					{#each ['draft', 'active', 'archived'] as status (status)}
						<option value={status}>{statusLabels[status]()}</option>
					{/each}
				</select>
			</label>
		</div>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_product_description()}</span>
			<textarea
				name="descriptionMd"
				rows="10"
				bind:value={draft.descriptionMd}
				data-testid="product-editor-description"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2 font-mono text-sm"
			></textarea>
		</label>

		<div>
			<div class="mb-1 flex items-center justify-between">
				<span class="text-sm font-medium">{m.admin_product_gallery()}</span>
				<button
					type="button"
					data-testid="product-editor-gallery-add"
					class="rounded bg-(--color-brand-soft) px-3 py-1 text-sm hover:opacity-80"
					onclick={() => (picker = 'gallery')}
				>
					{m.admin_product_gallery_add()}
				</button>
			</div>
			{#if draft.gallery.length > 0}
				<ul class="grid grid-cols-3 gap-3 sm:grid-cols-4" data-testid="product-editor-gallery">
					{#each draft.gallery as item, i (item.id)}
						<li class="relative">
							<input type="hidden" name="gallery" value={item.id} />
							{#if item.thumb}
								<Img
									image={item.thumb}
									alt=""
									decorative
									class="aspect-[4/3] w-full rounded bg-(--color-brand-soft)/20 object-cover"
								/>
							{:else}
								<div class="aspect-[4/3] w-full rounded bg-(--color-brand-soft)/40"></div>
							{/if}
							<button
								type="button"
								data-testid="product-editor-gallery-remove"
								class="absolute top-1 right-1 rounded bg-white/90 px-2 py-0.5 text-xs text-red-700 hover:bg-white"
								onclick={() => draft.gallery.splice(i, 1)}
							>
								{m.admin_product_gallery_remove()}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>

	<aside class="space-y-6">
		<CoverField
			bind:coverMediaId={draft.coverMediaId}
			bind:coverThumb={draft.coverThumb}
			heading={m.admin_product_cover()}
			noneText={m.admin_product_cover_none()}
			pickText={m.admin_product_cover_pick()}
			removeText={m.admin_product_cover_remove()}
			aspectClass="aspect-[4/3]"
			testidPrefix="product-editor"
			onpick={() => (picker = 'cover')}
		/>

		<PillarChecklist
			pillars={data.sitePillars}
			selected={draft.pillars}
			legend={m.admin_product_pillars()}
			testidPrefix="product-editor"
		/>

		<div class="space-y-2">
			<button
				type="submit"
				data-testid="product-editor-save"
				class="w-full rounded bg-(--color-brand) px-4 py-2 font-semibold text-white hover:opacity-90"
			>
				{m.admin_product_save()}
			</button>
			{#if saved}
				<p data-testid="product-editor-saved" class="text-center text-sm text-green-700">
					{m.admin_product_saved()}
				</p>
			{/if}
		</div>
	</aside>
</form>

{#if picker !== 'closed'}
	<MediaPicker items={data.library} onpick={onPick} onclose={() => (picker = 'closed')} />
{/if}
