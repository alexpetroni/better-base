<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { CHAT_ERRORS } from './copy.ts';

	interface DisplayMessage {
		role: 'user' | 'assistant';
		content: string;
	}

	let { variant = 'widget' }: { variant?: 'widget' | 'page' } = $props();

	let messages = $state<DisplayMessage[]>([]);
	let input = $state('');
	let busy = $state(false);
	let errorText = $state('');
	let listEl: HTMLDivElement | undefined = $state();

	// Keep the newest message in view while chunks stream in.
	$effect(() => {
		void messages.at(-1)?.content;
		if (listEl) listEl.scrollTop = listEl.scrollHeight;
	});

	async function send(event: SubmitEvent) {
		event.preventDefault();
		const text = input.trim();
		if (!text || busy) return;
		input = '';
		errorText = '';
		messages.push({ role: 'user', content: text });
		busy = true;
		try {
			const res = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: text })
			});
			if (!res.ok || !res.body) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				errorText = body?.error ?? CHAT_ERRORS.stream;
				return;
			}
			const assistantIndex = messages.push({ role: 'assistant', content: '' }) - 1;
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				// SSE frames end with a blank line; the remainder stays buffered.
				const frames = buffer.split('\n\n');
				buffer = frames.pop() ?? '';
				for (const frame of frames) {
					const data = frame.split('\n').find((line) => line.startsWith('data: '));
					if (!data) continue;
					let payload: { delta?: string; error?: string };
					try {
						payload = JSON.parse(data.slice(6));
					} catch {
						continue;
					}
					if (payload.delta) messages[assistantIndex].content += payload.delta;
					if (payload.error) errorText = payload.error;
				}
			}
		} catch {
			errorText = CHAT_ERRORS.stream;
		} finally {
			busy = false;
		}
	}

	async function reset() {
		await fetch('/api/chat', { method: 'DELETE' });
		messages = [];
		errorText = '';
	}
</script>

<div class="flex flex-col {variant === 'page' ? 'h-[32rem]' : 'h-96'}">
	<div bind:this={listEl} class="flex-1 space-y-3 overflow-y-auto p-3" data-testid="chat-messages">
		{#if messages.length === 0}
			<p class="text-sm text-(--color-ink)/60">{m.chat_empty()}</p>
		{/if}
		{#each messages as message, i (i)}
			<div
				data-testid="chat-message"
				data-role={message.role}
				class="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap {message.role === 'user'
					? 'ml-auto bg-(--color-brand) text-white'
					: 'bg-(--color-brand-soft)/40'}"
			>
				{message.content}
			</div>
		{/each}
		{#if errorText}
			<p class="text-sm text-red-700" data-testid="chat-error">{errorText}</p>
		{/if}
	</div>

	<div class="border-t border-(--color-brand-soft) p-3">
		<p class="mb-2 text-xs text-(--color-ink)/60" data-testid="chat-disclaimer">
			{m.chat_disclaimer()}
		</p>
		<form onsubmit={send} class="flex gap-2">
			<input
				type="text"
				name="chat-message"
				bind:value={input}
				placeholder={m.chat_placeholder()}
				maxlength="2000"
				autocomplete="off"
				class="min-w-0 flex-1 rounded border border-(--color-brand-soft) px-3 py-2 text-sm"
			/>
			<button
				type="submit"
				disabled={busy}
				class="rounded bg-(--color-brand) px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
			>
				{m.chat_send()}
			</button>
		</form>
		<button
			type="button"
			data-testid="chat-reset"
			onclick={reset}
			class="mt-2 text-xs text-(--color-ink)/60 underline hover:text-(--color-ink)"
		>
			{m.chat_reset()}
		</button>
	</div>
</div>
