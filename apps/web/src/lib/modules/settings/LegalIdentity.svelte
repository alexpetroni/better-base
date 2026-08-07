<script lang="ts">
	import { m } from '$lib/paraglide/messages';
	import { legalIdentity } from './legal.ts';
	import type { PublicSiteSettings } from './registry.ts';

	// Client-safe settings from the (public) layout load — the single source of
	// the trader identification. Fields the operator has not filled in yet
	// (or that still hold the seeded placeholder) are simply not rendered.
	let { settings }: { settings: PublicSiteSettings } = $props();

	const identity = $derived(legalIdentity(settings));
</script>

<div data-testid="legal-identity" class="text-sm text-(--color-ink)/70">
	{#if identity.legalName}
		<p data-testid="legal-identity-name" class="font-semibold">{identity.legalName}</p>
	{/if}
	<ul class="mt-1 space-y-0.5">
		{#if identity.cui}
			<li data-testid="legal-identity-cui">{m.legal_cui_label()}: {identity.cui}</li>
		{/if}
		{#if identity.regCom}
			<li data-testid="legal-identity-regcom">{m.legal_regcom_label()}: {identity.regCom}</li>
		{/if}
		{#if identity.address}
			<li data-testid="legal-identity-address" class="whitespace-pre-line">{identity.address}</li>
		{/if}
		{#if identity.contactEmail}
			<li data-testid="legal-identity-email">
				<a href="mailto:{identity.contactEmail}" class="underline hover:text-(--color-ink)">
					{identity.contactEmail}
				</a>
			</li>
		{/if}
		{#if identity.contactPhone}
			<li data-testid="legal-identity-phone">
				<a href="tel:{identity.contactPhone}" class="underline hover:text-(--color-ink)">
					{identity.contactPhone}
				</a>
			</li>
		{/if}
	</ul>
	{#if identity.anpcSalUrl || identity.anpcSolUrl}
		<!-- eslint-disable svelte/no-navigation-without-resolve -- external ANPC/EU SOL destinations from settings, not app routes -->
		<ul class="mt-2 space-y-0.5">
			{#if identity.anpcSalUrl}
				<li>
					<a
						data-testid="legal-anpc-sal"
						href={identity.anpcSalUrl}
						target="_blank"
						rel="noopener"
						class="underline hover:text-(--color-ink)"
					>
						{m.legal_anpc_sal()}
					</a>
				</li>
			{/if}
			{#if identity.anpcSolUrl}
				<li>
					<a
						data-testid="legal-anpc-sol"
						href={identity.anpcSolUrl}
						target="_blank"
						rel="noopener"
						class="underline hover:text-(--color-ink)"
					>
						{m.legal_anpc_sol()}
					</a>
				</li>
			{/if}
		</ul>
		<!-- eslint-enable svelte/no-navigation-without-resolve -->
	{/if}
	{#if identity.extraNotices}
		<p data-testid="legal-identity-extra" class="mt-2 whitespace-pre-line">
			{identity.extraNotices}
		</p>
	{/if}
</div>
