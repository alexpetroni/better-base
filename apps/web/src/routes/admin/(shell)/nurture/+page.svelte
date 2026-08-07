<script lang="ts">
	import { formatDate } from '$lib/util/date';
	import { m } from '$lib/paraglide/messages';

	let { data } = $props();

	const triggerLabels: Record<string, () => string> = {
		'consent-confirmed': m.admin_nurture_trigger_consent,
		'quiz-completed': m.admin_nurture_trigger_quiz,
		'order-paid': m.admin_nurture_trigger_order
	};
</script>

<svelte:head>
	<title>{m.admin_nav_nurture()}</title>
</svelte:head>

<h1 class="mb-4 text-2xl font-bold">{m.admin_nav_nurture()}</h1>

{#if data.sequences.length === 0}
	<p data-testid="nurture-empty" class="text-(--color-ink)/70">{m.admin_nurture_empty()}</p>
{:else}
	<table
		data-testid="nurture-table"
		class="w-full rounded-lg border border-(--color-brand-soft) bg-white text-sm"
	>
		<thead>
			<tr class="border-b border-(--color-brand-soft) text-left">
				<th class="px-3 py-2">{m.admin_nurture_col_name()}</th>
				<th class="px-3 py-2">{m.admin_nurture_col_trigger()}</th>
				<th class="px-3 py-2">{m.admin_nurture_col_steps()}</th>
				<th class="px-3 py-2">{m.admin_nurture_col_enrolled()}</th>
				<th class="px-3 py-2">{m.admin_nurture_col_sends()}</th>
				<th class="px-3 py-2">{m.admin_nurture_col_status()}</th>
				<th class="px-3 py-2"></th>
			</tr>
		</thead>
		<tbody>
			{#each data.sequences as row (row.sequence.id)}
				<tr
					data-testid="nurture-row"
					data-key={row.sequence.key}
					class="border-b border-(--color-brand-soft)/50"
				>
					<td class="px-3 py-2 font-medium">
						{row.sequence.name}
						<span class="block text-xs text-(--color-ink)/50">{row.sequence.key}</span>
					</td>
					<td class="px-3 py-2">
						{triggerLabels[row.sequence.trigger.kind]?.() ?? row.sequence.trigger.kind}
						{#if row.sequence.trigger.kind === 'quiz-completed'}
							<span class="block text-xs text-(--color-ink)/50"
								>{row.sequence.trigger.quizSlug}</span
							>
						{/if}
					</td>
					<td class="px-3 py-2">{row.sequence.steps.length}</td>
					<td class="px-3 py-2" data-testid="nurture-enrolled">{row.enrolled}</td>
					<td class="px-3 py-2" data-testid="nurture-sends">
						{row.pendingSends} / {row.sentSends} / {row.failedSends}
					</td>
					<td class="px-3 py-2">
						{#if row.sequence.active}
							<span class="rounded bg-green-100 px-2 py-0.5 text-xs text-green-800"
								>{m.admin_nurture_active()}</span
							>
						{:else}
							<span
								data-testid="nurture-inactive"
								class="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900"
								>{m.admin_nurture_inactive()}</span
							>
						{/if}
					</td>
					<td class="px-3 py-2 text-right">
						<form method="POST" action="?/toggle">
							<input type="hidden" name="id" value={row.sequence.id} />
							<input type="hidden" name="active" value={row.sequence.active ? 'false' : 'true'} />
							<button
								type="submit"
								data-testid="nurture-toggle-{row.sequence.key}"
								class="rounded bg-(--color-brand-soft) px-3 py-1 text-xs font-semibold hover:opacity-90"
							>
								{row.sequence.active ? m.admin_nurture_deactivate() : m.admin_nurture_activate()}
							</button>
						</form>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

<h2 class="mt-8 mb-3 text-lg font-semibold">{m.admin_nurture_parked_title()}</h2>
{#if data.parked.length === 0}
	<p data-testid="nurture-parked-empty" class="text-(--color-ink)/70">
		{m.admin_nurture_parked_empty()}
	</p>
{:else}
	<table
		data-testid="nurture-parked-table"
		class="w-full rounded-lg border border-(--color-brand-soft) bg-white text-sm"
	>
		<thead>
			<tr class="border-b border-(--color-brand-soft) text-left">
				<th class="px-3 py-2">{m.admin_nurture_parked_col_email()}</th>
				<th class="px-3 py-2">{m.admin_nurture_col_name()}</th>
				<th class="px-3 py-2">{m.admin_nurture_parked_col_step()}</th>
				<th class="px-3 py-2">{m.admin_nurture_parked_col_attempts()}</th>
				<th class="px-3 py-2">{m.admin_nurture_parked_col_error()}</th>
			</tr>
		</thead>
		<tbody>
			{#each data.parked as send (send.sendId)}
				<tr data-testid="nurture-parked-row" class="border-b border-(--color-brand-soft)/50">
					<td class="px-3 py-2 font-medium">{send.email}</td>
					<td class="px-3 py-2">{send.sequenceName}</td>
					<td class="px-3 py-2">{send.stepIndex + 1}</td>
					<td class="px-3 py-2">{send.attempts}</td>
					<td class="px-3 py-2 text-(--color-ink)/70">
						{send.lastError ?? '—'}
						<span class="block text-xs text-(--color-ink)/50"
							>{formatDate(send.scheduledAt, 'medium-time')}</span
						>
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}
