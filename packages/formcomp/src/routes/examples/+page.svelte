<script lang="ts">
	import { resolve } from '$app/paths';
	import { examples } from '$examples';
</script>

<svelte:head>
	<title>formComp examples</title>
</svelte:head>

<div class="min-h-screen bg-background py-8 px-4 sm:px-6 lg:px-8">
	<div class="mx-auto max-w-3xl">
		<header class="mb-8">
			<a href={resolve('/')} class="text-sm text-muted-foreground hover:text-foreground">
				← Home
			</a>
			<h1 class="mt-2 text-3xl font-bold tracking-tight">formComp examples</h1>
			<p class="mt-2 text-muted-foreground">
				Each example is a plain <code>FormConfig</code> object in
				<code>/examples</code>. Pick one below to try it out.
			</p>
		</header>

		<ul class="space-y-3">
			{#each examples as example (example.slug)}
				<li>
					<a
						href={resolve('/examples/[slug]', { slug: example.slug })}
						class="block rounded-lg border bg-card p-4 transition-colors hover:border-foreground/30 hover:bg-accent"
					>
						<h2 class="text-lg font-semibold">{example.title}</h2>
						<p class="mt-1 text-sm text-muted-foreground">{example.description}</p>
						<p class="mt-2 text-xs text-muted-foreground/80">
							examples/{example.slug}.ts
						</p>
					</a>
				</li>
			{/each}
		</ul>
	</div>
</div>
