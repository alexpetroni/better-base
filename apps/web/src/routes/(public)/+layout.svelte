<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import {
		baseLocale,
		deLocalizeUrl,
		localizeHref,
		strategy,
		type Locale
	} from '$lib/paraglide/runtime';
	import { canonicalUrl, hreflangAlternates } from '$lib/seo';
	import { AnalyticsLoader } from '$lib/modules/analytics';
	import { ChatWidget } from '$lib/modules/chat';
	import { NewsletterSignup } from '$lib/modules/crm';
	import { CookieConsent, type CookieConsentValue } from '$lib/modules/gdpr';
	import { LegalIdentity } from '$lib/modules/settings';

	let { data, children } = $props();

	// Merged page data, so a page load that mutates the cart cookie (checkout
	// success) can override the count the layout load read before the mutation.
	const cartCount = $derived(page.data.cartCount ?? 0);

	// Live consent decision: the server-read cookie until the banner (or the
	// consent manager, which reloads) changes it. Feeds the consent-gated
	// analytics loader, so accepting in the banner takes effect immediately.
	let localDecision = $state<CookieConsentValue | null>(null);
	const consentDecision = $derived(localDecision ?? data.cookieConsent);

	// hreflang alternates — only when the SITE has more than one locale and
	// paraglide resolves locales from the URL (FIX-15; see hreflangAlternates).
	// Today both sites are `ro` only, so nothing is emitted. When they are,
	// each is the locale-less (base) pathname localized per locale, absolute
	// via PUBLIC_SITE_URL, with x-default at the base locale.
	const basePath = $derived(deLocalizeUrl(page.url).pathname);
	const alternates = $derived(
		hreflangAlternates(data.site.locales, strategy, baseLocale, (locale) =>
			canonicalUrl(localizeHref(basePath, { locale: locale as Locale }))
		)
	);
</script>

<svelte:head>
	{#each alternates as alt (alt.hreflang)}
		<link rel="alternate" hreflang={alt.hreflang} href={alt.href} />
	{/each}
</svelte:head>

<header class="border-b border-(--color-brand-soft) bg-(--color-brand) text-white">
	<div class="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
		<a href={resolve('/')} class="text-lg font-bold">{data.site.name}</a>
		<nav>
			<ul class="flex items-center gap-4">
				{#each data.site.nav as item (item.href)}
					<li>
						<!-- Static config hrefs; cast to a static route type because the Pathname
					     union (with dynamic routes) defeats resolve()'s overloads. -->
						<a href={resolve(item.href as '/')} class="hover:underline">{item.label}</a>
					</li>
				{/each}
				<li>
					<a
						href={resolve('/(public)/cos')}
						data-testid="cart-link"
						class="flex items-center gap-1 rounded bg-white/10 px-2 py-1 hover:bg-white/20"
					>
						{m.shop_cart_link()}
						{#if cartCount > 0}
							<span
								data-testid="cart-count"
								class="rounded-full bg-(--color-accent) px-2 text-sm font-semibold"
							>
								{cartCount}
							</span>
						{/if}
					</a>
				</li>
			</ul>
		</nav>
	</div>
</header>

<main class="mx-auto max-w-4xl px-4 py-8">
	{@render children()}
</main>

<footer class="mt-12 border-t border-(--color-brand-soft) bg-(--color-brand-soft)/20">
	<div class="mx-auto max-w-4xl px-4 py-10">
		<NewsletterSignup source="footer" />
		<nav aria-label={m.footer_legal_aria()} class="mt-8">
			<ul class="flex flex-wrap gap-4 text-sm">
				{#each data.site.footerLinks as link (link.href)}
					<li>
						<a
							href={resolve(link.href as '/')}
							class="text-(--color-ink)/70 underline hover:text-(--color-ink)"
						>
							{link.label}
						</a>
					</li>
				{/each}
			</ul>
		</nav>
		<!-- RO e-commerce: the trader identification + ANPC/SOL links must be
		     visible on every page — rendered from /admin/settings, never hardcoded. -->
		<div class="mt-6">
			<LegalIdentity settings={data.publicSettings} />
		</div>
		<p class="mt-4 text-sm text-(--color-ink)/70">© {data.site.name}</p>
	</div>
</footer>

{#if data.site.chatWidget}
	<ChatWidget />
{/if}

<CookieConsent initial={data.cookieConsent} onchange={(value) => (localDecision = value)} />
<AnalyticsLoader config={data.analytics} decision={consentDecision} />
