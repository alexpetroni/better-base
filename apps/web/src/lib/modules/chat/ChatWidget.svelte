<script lang="ts">
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import ChatPanel from './ChatPanel.svelte';

	let open = $state(false);
</script>

<div class="fixed right-4 bottom-4 z-50 flex flex-col items-end">
	{#if open}
		<div
			class="mb-2 flex w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-(--color-brand-soft) bg-(--color-surface) shadow-xl"
			data-testid="chat-panel"
		>
			<header
				class="flex items-center justify-between bg-(--color-brand) px-3 py-2 text-sm font-semibold text-white"
			>
				<span>{m.chat_title()}</span>
				<a href={resolve('/(public)/asistent')} class="text-xs font-normal underline">
					{m.chat_full_page()}
				</a>
			</header>
			<ChatPanel />
		</div>
	{/if}
	<button
		type="button"
		data-testid="chat-toggle"
		aria-expanded={open}
		onclick={() => (open = !open)}
		class="rounded-full bg-(--color-brand) px-4 py-3 text-sm font-semibold text-white shadow-lg hover:opacity-90"
	>
		{open ? m.chat_close() : m.chat_open()}
	</button>
</div>
