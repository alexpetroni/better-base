<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { CHAT_ERRORS } from './copy.ts';

	interface DisplayMessage {
		role: 'user' | 'assistant';
		content: string;
		/** Streaming broke off mid-reply — the content is incomplete. */
		failed?: boolean;
	}

	let { variant = 'widget' }: { variant?: 'widget' | 'page' } = $props();

	const uid = $props.id();

	let messages = $state<DisplayMessage[]>([]);
	let input = $state('');
	let busy = $state(false);
	let errorText = $state('');
	let listEl: HTMLDivElement | undefined = $state();
	let inputEl: HTMLInputElement | undefined = $state();
	// Auto-scroll only while the reader is at (or near) the bottom — someone who
	// scrolled up to re-read must not have their position hijacked per token.
	let pinned = true;

	export function focusInput() {
		inputEl?.focus();
	}

	function onListScroll() {
		if (!listEl) return;
		pinned = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 48;
	}

	// Keep the newest message in view while chunks stream in (only when pinned).
	$effect(() => {
		void messages.at(-1)?.content;
		if (listEl && pinned) listEl.scrollTop = listEl.scrollHeight;
	});

	async function deliver(text: string) {
		errorText = '';
		busy = true;
		let assistantIndex = -1;
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
			assistantIndex = messages.push({ role: 'assistant', content: '' }) - 1;
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
			// A reply that broke off mid-stream is marked failed (retry affordance)
			// rather than left looking like a complete answer; an empty bubble is
			// dropped entirely.
			if (errorText && assistantIndex !== -1) {
				if (messages[assistantIndex].content) messages[assistantIndex].failed = true;
				else messages.splice(assistantIndex, 1);
			}
			busy = false;
		}
	}

	async function send(event: SubmitEvent) {
		event.preventDefault();
		const text = input.trim();
		if (!text || busy) return;
		input = '';
		messages.push({ role: 'user', content: text });
		await deliver(text);
	}

	// Re-ask the question whose reply broke off. The server already stored the
	// original user message, so the provider sees the question twice — accurate
	// (it WAS asked twice) and harmless for context.
	async function retry() {
		if (busy) return;
		const lastUser = messages.findLast((msg) => msg.role === 'user');
		if (!lastUser) return;
		const last = messages.at(-1);
		if (last?.role === 'assistant' && last.failed) messages.pop();
		await deliver(lastUser.content);
	}

	async function reset() {
		await fetch('/api/chat', { method: 'DELETE' });
		messages = [];
		errorText = '';
		pinned = true;
	}
</script>

<div class="flex flex-col {variant === 'page' ? 'h-[32rem]' : 'h-96'}">
	<!-- role=log + aria-live announce streamed replies to screen readers;
	     aria-atomic=false so only appended text is read, not the whole log. -->
	<div
		bind:this={listEl}
		onscroll={onListScroll}
		role="log"
		aria-live="polite"
		aria-atomic="false"
		aria-busy={busy}
		aria-label={m.chat_title()}
		class="flex-1 space-y-3 overflow-y-auto p-3"
		data-testid="chat-messages"
	>
		{#if messages.length === 0}
			<p class="text-sm text-(--color-ink)/70">{m.chat_empty()}</p>
		{/if}
		{#each messages as message, i (i)}
			<div
				data-testid="chat-message"
				data-role={message.role}
				data-failed={message.failed ? 'true' : undefined}
				class="max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap {message.role === 'user'
					? 'ml-auto bg-(--color-brand) text-white'
					: 'bg-(--color-brand-soft)/40'} {message.failed ? 'border border-red-300' : ''}"
			>
				{message.content}
				{#if message.failed}
					<span class="mt-1 block text-xs text-red-700">{m.chat_reply_failed()}</span>
				{/if}
			</div>
		{/each}
		{#if errorText}
			<p class="text-sm text-red-700" data-testid="chat-error">{errorText}</p>
		{/if}
		{#if !busy && messages.at(-1)?.failed}
			<button
				type="button"
				data-testid="chat-retry"
				onclick={retry}
				class="rounded border border-(--color-brand) px-3 py-1 text-sm font-semibold text-(--color-brand) hover:bg-(--color-brand-soft)/40"
			>
				{m.chat_retry()}
			</button>
		{/if}
	</div>

	<div class="border-t border-(--color-brand-soft) p-3">
		<p class="mb-2 text-xs text-(--color-ink)/70" data-testid="chat-disclaimer">
			{m.chat_disclaimer()}
		</p>
		<form onsubmit={send} class="flex gap-2">
			<label for="chat-input-{uid}" class="sr-only">{m.chat_input_label()}</label>
			<input
				type="text"
				id="chat-input-{uid}"
				name="chat-message"
				bind:this={inputEl}
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
			class="mt-2 text-xs text-(--color-ink)/70 underline hover:text-(--color-ink)"
		>
			{m.chat_reset()}
		</button>
	</div>
</div>
