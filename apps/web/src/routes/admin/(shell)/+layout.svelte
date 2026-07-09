<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages';

	let { data, children } = $props();

	const navLabels: Record<string, () => string> = {
		dashboard: m.admin_nav_dashboard,
		articles: m.admin_nav_articles,
		products: m.admin_nav_products,
		quizzes: m.admin_nav_quizzes,
		media: m.admin_nav_media,
		subscribers: m.admin_nav_subscribers,
		orders: m.admin_nav_orders,
		settings: m.admin_nav_settings
	};
</script>

<div class="flex min-h-screen">
	<aside
		data-testid="admin-sidebar"
		class="w-56 shrink-0 border-r border-(--color-brand-soft) bg-white"
	>
		<div class="border-b border-(--color-brand-soft) px-4 py-4">
			<a href={resolve('/admin')} class="font-bold text-(--color-brand)">{data.site.name}</a>
		</div>
		<nav class="p-2">
			<ul class="space-y-1">
				{#each data.adminNav as item (item.href)}
					<li>
						<a
							href={resolve(item.href as '/admin')}
							data-testid="admin-nav-{item.message}"
							class="block rounded px-3 py-2 text-sm hover:bg-(--color-brand-soft)
								{page.url.pathname === item.href ? 'bg-(--color-brand-soft) font-semibold' : ''}"
						>
							{navLabels[item.message]()}
						</a>
					</li>
				{/each}
			</ul>
		</nav>
	</aside>

	<div class="flex min-w-0 flex-1 flex-col">
		<header
			class="flex items-center justify-between border-b border-(--color-brand-soft) bg-white px-6 py-3"
		>
			<span class="text-sm text-(--color-ink)/70">{data.site.name}</span>
			<div class="flex items-center gap-4">
				<span data-testid="admin-user" class="text-sm">
					{data.user.email}
					<span class="ml-1 rounded bg-(--color-brand-soft) px-2 py-0.5 text-xs">
						{data.user.role}
					</span>
				</span>
				<form method="POST" action={resolve('/admin/logout')}>
					<button
						type="submit"
						data-testid="admin-logout"
						class="text-sm text-(--color-brand) hover:underline"
					>
						{m.admin_logout()}
					</button>
				</form>
			</div>
		</header>

		<main class="flex-1 p-6">
			{@render children()}
		</main>
	</div>
</div>
