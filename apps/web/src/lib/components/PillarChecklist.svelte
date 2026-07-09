<script lang="ts">
	// The pillar-tagging checkbox list shared by the article and product
	// editors (the quiz editor uses a single-select and keeps its own control).
	// Posts repeated `pillars` values; legend/testids come from the parent.
	let {
		pillars,
		selected,
		legend,
		testidPrefix
	}: {
		pillars: Array<{ slug: string; name: string }>;
		selected: string[];
		legend: string;
		testidPrefix: string;
	} = $props();
</script>

<fieldset class="rounded-lg border border-(--color-brand-soft) bg-white p-4">
	<legend class="px-1 text-sm font-semibold">{legend}</legend>
	<ul class="space-y-1">
		{#each pillars as pillar (pillar.slug)}
			<li>
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						name="pillars"
						value={pillar.slug}
						checked={selected.includes(pillar.slug)}
						data-testid="{testidPrefix}-pillar-{pillar.slug}"
					/>
					{pillar.name}
				</label>
			</li>
		{/each}
	</ul>
</fieldset>
