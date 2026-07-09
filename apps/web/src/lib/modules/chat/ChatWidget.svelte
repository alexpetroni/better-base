<script lang="ts">
	import { tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { m } from '$lib/paraglide/messages';
	import ChatPanel from './ChatPanel.svelte';

	let open = $state(false);
	let panel = $state<ReturnType<typeof ChatPanel>>();
	let toggleEl = $state<HTMLButtonElement>();

	async function toggle() {
		open = !open;
		if (open) {
			await tick();
			panel?.focusInput();
		}
	}

	// Escape closes the open widget (dialog convention) and hands focus back to
	// the toggle so keyboard users don't lose their place.
	function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !open) return;
		open = false;
		toggleEl?.focus();
	}
</script>

<svelte:window onkeydown={onKeydown} />

<!-- --cookie-banner-h is set by CookieConsent while the banner is visible, so
     the widget sits above it instead of being occluded (audit frontend #13). -->
<div
	class="fixed right-4 z-50 flex flex-col items-end"
	style="bottom: calc(1rem + var(--cookie-banner-h, 0px))"
>
	{#if open}
		<div
			class="mb-2 flex w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border border-(--color-brand-soft) bg-(--color-surface) shadow-xl"
			data-testid="chat-panel"
			role="dialog"
			aria-label={m.chat_title()}
		>
			<header
				class="flex items-center justify-between bg-(--color-brand) px-3 py-2 text-sm font-semibold text-white"
			>
				<span>{m.chat_title()}</span>
				<a href={resolve('/(public)/asistent')} class="text-xs font-normal underline">
					{m.chat_full_page()}
				</a>
			</header>
			<ChatPanel bind:this={panel} />
		</div>
	{/if}
	<button
		type="button"
		bind:this={toggleEl}
		data-testid="chat-toggle"
		aria-expanded={open}
		onclick={toggle}
		class="rounded-full bg-(--color-brand) px-4 py-3 text-sm font-semibold text-white shadow-lg hover:opacity-90"
	>
		{open ? m.chat_close() : m.chat_open()}
	</button>
</div>
