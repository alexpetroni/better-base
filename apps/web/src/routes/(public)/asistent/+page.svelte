<script lang="ts">
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import { ChatPanel } from '$lib/modules/chat';
</script>

<svelte:head>
	<title>{m.chat_title()} — {page.data.site.name}</title>
</svelte:head>

<h1 class="text-2xl font-bold">{m.chat_title()}</h1>
<p class="mt-2 text-(--color-ink)/70">{m.chat_page_intro()}</p>

<div class="mt-6 overflow-hidden rounded-lg border border-(--color-brand-soft)">
	<ChatPanel variant="page" />
</div>
