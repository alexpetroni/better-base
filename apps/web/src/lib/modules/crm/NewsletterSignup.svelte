<script lang="ts">
	import { m } from '$lib/paraglide/messages';

	// GDPR: the consent checkbox starts UNTICKED and is required to submit.
	// Plain form POST to /newsletter (works without JS); `source` tells the
	// consent record where the signup came from.
	let { source = 'footer' }: { source?: string } = $props();
</script>

<form method="POST" action="/newsletter" class="max-w-md" data-testid="newsletter-form">
	<h2 class="mb-2 text-lg font-semibold">{m.newsletter_heading()}</h2>
	<p class="mb-3 text-sm opacity-80">{m.newsletter_blurb()}</p>
	<input type="hidden" name="source" value={source} />
	<div class="flex gap-2">
		<input
			type="email"
			name="email"
			required
			data-testid="newsletter-email"
			placeholder={m.newsletter_email_placeholder()}
			class="grow rounded border border-(--color-brand-soft) bg-white px-3 py-2 text-(--color-ink)"
		/>
		<button
			type="submit"
			data-testid="newsletter-submit"
			class="rounded bg-(--color-accent) px-4 py-2 font-semibold text-(--color-ink) hover:opacity-90"
		>
			{m.newsletter_submit()}
		</button>
	</div>
	<label class="mt-3 flex items-start gap-2 text-sm">
		<input
			type="checkbox"
			name="newsletter_consent"
			value="yes"
			required
			data-testid="newsletter-consent"
			class="mt-0.5"
		/>
		<span>{m.newsletter_consent_label()}</span>
	</label>
</form>
