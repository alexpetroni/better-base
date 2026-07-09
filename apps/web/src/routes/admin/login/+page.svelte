<script lang="ts">
	import { enhance } from '$app/forms';
	import { m } from '$lib/paraglide/messages';

	let { data, form } = $props();

	// Disable the button while the action is in flight so a double-click can't
	// fire two login attempts (each would consume a rate-limit slot).
	let submitting = $state(false);
</script>

<svelte:head>
	<title>{m.admin_login_title()} — {data.site.name}</title>
</svelte:head>

<div class="mx-auto mt-16 w-full max-w-sm px-4">
	<h1 class="mb-1 text-2xl font-bold">{data.site.name}</h1>
	<p class="mb-6 text-(--color-ink)/70">{m.admin_login_title()}</p>

	{#if form?.error === 'invalid_credentials'}
		<p data-testid="login-error" class="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
			{m.admin_login_invalid()}
		</p>
	{:else if form?.error === 'rate_limited'}
		<p data-testid="login-rate-limited" class="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
			{m.admin_login_rate_limited()}
		</p>
	{/if}

	<form
		method="POST"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update();
				submitting = false;
			};
		}}
		class="space-y-4"
	>
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_login_email()}</span>
			<input
				type="email"
				name="email"
				required
				autocomplete="email"
				value={form?.email ?? ''}
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2"
			/>
		</label>
		<label class="block">
			<span class="mb-1 block text-sm font-medium">{m.admin_login_password()}</span>
			<input
				type="password"
				name="password"
				required
				autocomplete="current-password"
				class="w-full rounded border border-(--color-brand-soft) px-3 py-2"
			/>
		</label>
		<button
			type="submit"
			disabled={submitting}
			class="w-full rounded bg-(--color-brand) px-4 py-2 font-semibold text-white hover:opacity-90 disabled:opacity-50"
		>
			{m.admin_login_submit()}
		</button>
	</form>
</div>
