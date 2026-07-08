<script lang="ts">
	import { TextInput } from 'formcomp';
	import 'formcomp/theme.css';
	import { m } from '$lib/paraglide/messages';

	let value = $state('');
</script>

<svelte:head>
	<title>{m.dev_form_heading()}</title>
</svelte:head>

<h1 class="mb-6 text-2xl font-bold">{m.dev_form_heading()}</h1>

<div class="formcomp max-w-md">
	<TextInput name="demo" label="Nume" placeholder="Ex: Ana" bind:value />
</div>

<p class="mt-4 text-sm" data-testid="form-echo">{value}</p>
