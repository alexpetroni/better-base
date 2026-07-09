<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { m } from '$lib/paraglide/messages';
	import { Img } from '$lib/modules/media';

	let { data, form } = $props();

	let fileInput = $state<HTMLInputElement | null>(null);
	let dragOver = $state(false);
	let uploading = $state(false);
	let uploadErrors = $state<string[]>([]);
	let savedAltId = $state<string | null>(null);

	function reasonMessage(code: string): string {
		if (code === 'invalid-mime') return m.admin_media_err_mime();
		if (code === 'invalid-size') return m.admin_media_err_size();
		return m.admin_media_err_server();
	}

	// Cheap client-side pre-check; the server re-validates and the presigned
	// signature pins content-type and length at the storage level.
	function precheck(file: File): string | null {
		if (!data.constraints.mimes.includes(file.type)) return 'invalid-mime';
		if (file.size === 0 || file.size > data.constraints.maxBytes) return 'invalid-size';
		return null;
	}

	async function uploadOne(file: File): Promise<string | null> {
		const early = precheck(file);
		if (early) return reasonMessage(early);

		const presignRes = await fetch('/admin/media/upload', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ op: 'presign', filename: file.name, mime: file.type, size: file.size })
		});
		if (!presignRes.ok) return reasonMessage((await presignRes.json()).error ?? '');
		const { key, uploadUrl, ticket } = await presignRes.json();

		const putRes = await fetch(uploadUrl, {
			method: 'PUT',
			headers: { 'content-type': file.type },
			body: file
		});
		if (!putRes.ok) return m.admin_media_err_server();

		const confirmRes = await fetch('/admin/media/upload', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ op: 'confirm', key, ticket, filename: file.name })
		});
		if (!confirmRes.ok) return reasonMessage((await confirmRes.json()).error ?? '');
		return null;
	}

	async function uploadFiles(files: Iterable<File>) {
		uploading = true;
		uploadErrors = [];
		try {
			for (const file of files) {
				try {
					const failure = await uploadOne(file);
					if (failure) {
						uploadErrors = [
							...uploadErrors,
							m.admin_media_upload_failed({ filename: file.name, reason: failure })
						];
					}
				} catch {
					uploadErrors = [
						...uploadErrors,
						m.admin_media_upload_failed({ filename: file.name, reason: m.admin_media_err_server() })
					];
				}
			}
			await invalidateAll();
		} finally {
			uploading = false;
		}
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragOver = false;
		const files = event.dataTransfer?.files;
		if (files?.length) void uploadFiles(files);
	}

	function onFilesPicked() {
		const files = fileInput?.files;
		if (files?.length) void uploadFiles(Array.from(files));
		if (fileInput) fileInput.value = '';
	}
</script>

<svelte:head>
	<title>{m.admin_nav_media()}</title>
</svelte:head>

<h1 class="mb-4 text-2xl font-bold">{m.admin_nav_media()}</h1>

<button
	type="button"
	data-testid="media-dropzone"
	class="mb-2 flex w-full flex-col items-center gap-1 rounded-lg border-2 border-dashed px-4 py-8 text-(--color-ink)/70 transition-colors
		{dragOver ? 'border-(--color-brand) bg-(--color-brand-soft)/30' : 'border-(--color-brand-soft)'}"
	onclick={() => fileInput?.click()}
	ondragover={(e) => {
		e.preventDefault();
		dragOver = true;
	}}
	ondragleave={() => (dragOver = false)}
	ondrop={onDrop}
>
	<span class="font-medium">{m.admin_media_dropzone()}</span>
	<span class="text-sm">{m.admin_media_hint()}</span>
	{#if uploading}
		<span data-testid="media-uploading" class="text-sm font-medium text-(--color-brand)">
			{m.admin_media_uploading()}
		</span>
	{/if}
</button>
<input
	bind:this={fileInput}
	data-testid="media-file-input"
	type="file"
	accept={data.constraints.mimes.join(',')}
	multiple
	class="hidden"
	onchange={onFilesPicked}
/>

{#each uploadErrors as message (message)}
	<p data-testid="media-upload-error" class="mb-2 rounded bg-red-50 p-3 text-sm text-red-700">
		{message}
	</p>
{/each}
{#if form?.error === 'referenced'}
	<p data-testid="media-referenced-error" class="mb-2 rounded bg-red-50 p-3 text-sm text-red-700">
		{m.admin_media_referenced({ by: form.detail ?? '' })}
	</p>
{/if}

{#if data.items.length === 0}
	<p data-testid="media-empty" class="mt-6 text-(--color-ink)/70">{m.admin_media_empty()}</p>
{:else}
	<ul class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
		{#each data.items as item (item.row.id)}
			<li
				data-testid="media-item"
				data-filename={item.row.filename}
				class="flex flex-col overflow-hidden rounded-lg border border-(--color-brand-soft) bg-white"
			>
				{#if item.thumb}
					<Img
						image={item.thumb}
						alt={item.row.alt || (item.row.filename ?? '')}
						class="aspect-[4/3] w-full bg-(--color-brand-soft)/20 object-cover"
					/>
				{:else}
					<div
						class="flex aspect-[4/3] w-full items-center justify-center bg-(--color-brand-soft)/20 text-sm font-medium"
					>
						{m.admin_media_video_badge({ provider: item.row.videoProvider ?? '' })}
						<span class="ml-1 text-(--color-ink)/60">{item.row.videoExternalId}</span>
					</div>
				{/if}
				<div class="flex flex-1 flex-col gap-2 p-3 text-sm">
					<p class="truncate font-medium" title={item.row.filename}>{item.row.filename}</p>
					{#if item.row.width && item.row.height}
						<p class="text-(--color-ink)/60">
							{m.admin_media_dimensions({ width: item.row.width, height: item.row.height })}
						</p>
					{/if}
					<form
						method="POST"
						action="?/updateAlt"
						use:enhance={() =>
							async ({ update }) => {
								await update({ reset: false });
								savedAltId = item.row.id;
							}}
						class="flex items-end gap-2"
					>
						<input type="hidden" name="id" value={item.row.id} />
						<label class="block grow">
							<span class="mb-1 block text-xs text-(--color-ink)/60">
								{m.admin_media_alt_label()}
							</span>
							<input
								type="text"
								name="alt"
								data-testid="media-alt-input"
								value={item.row.alt}
								class="w-full rounded border border-(--color-brand-soft) px-2 py-1"
							/>
						</label>
						<button
							type="submit"
							data-testid="media-alt-save"
							class="rounded bg-(--color-brand) px-3 py-1 font-semibold text-white hover:opacity-90"
						>
							{m.admin_media_alt_save()}
						</button>
					</form>
					{#if savedAltId === item.row.id && form?.updated === item.row.id}
						<p data-testid="media-alt-saved" class="text-xs text-green-700">
							{m.admin_media_alt_saved()}
						</p>
					{/if}
					<form method="POST" action="?/delete" use:enhance class="mt-auto text-right">
						<input type="hidden" name="id" value={item.row.id} />
						<button
							type="submit"
							data-testid="media-delete"
							class="rounded px-2 py-1 text-red-700 hover:bg-red-50"
						>
							{m.admin_media_delete()}
						</button>
					</form>
				</div>
			</li>
		{/each}
	</ul>
{/if}
