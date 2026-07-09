<script lang="ts">
	import { resolve } from '$app/paths';
	import { NewsletterSignup } from '$lib/modules/crm';

	let { data, children } = $props();
</script>

<header class="border-b border-(--color-brand-soft) bg-(--color-brand) text-white">
	<div class="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
		<a href={resolve('/')} class="text-lg font-bold">{data.site.name}</a>
		<nav>
			<ul class="flex gap-4">
				{#each data.site.nav as item (item.href)}
					<li>
						<!-- Static config hrefs; cast to a static route type because the Pathname
					     union (with dynamic routes) defeats resolve()'s overloads. -->
						<a href={resolve(item.href as '/')} class="hover:underline">{item.label}</a>
					</li>
				{/each}
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
		<p class="mt-8 text-sm text-(--color-ink)/60">© {data.site.name}</p>
	</div>
</footer>
