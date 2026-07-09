<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';
	import { ChatWidget } from '$lib/modules/chat';
	import { NewsletterSignup } from '$lib/modules/crm';
	import { CookieConsent } from '$lib/modules/gdpr';

	let { data, children } = $props();

	// Merged page data, so a page load that mutates the cart cookie (checkout
	// success) can override the count the layout load read before the mutation.
	const cartCount = $derived(page.data.cartCount ?? 0);
</script>

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
		<nav aria-label="Linkuri legale" class="mt-8">
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
		<p class="mt-4 text-sm text-(--color-ink)/70">© {data.site.name}</p>
	</div>
</footer>

{#if data.site.chatWidget}
	<ChatWidget />
{/if}

<CookieConsent initial={data.cookieConsent} />
