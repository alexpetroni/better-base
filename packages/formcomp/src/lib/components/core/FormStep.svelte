<script lang="ts">
	import { setContext } from 'svelte';
	import { STEP_ID_KEY, type StepConfig } from '../../types.js';
	import StepContainer from '../layout/StepContainer.svelte';
	import GroupRenderer from './GroupRenderer.svelte';

	interface Props {
		stepConfig: StepConfig;
		warningGroupId?: string | null;
		warningMessage?: string;
	}

	let { stepConfig, warningGroupId = null, warningMessage }: Props = $props();

	// Set step ID context — this component is re-created via {#key} on step change
	setContext(STEP_ID_KEY, stepConfig.id);
</script>

<StepContainer title={stepConfig.label} intro={stepConfig.intro} class={stepConfig.class}>
	{#each stepConfig.groups as group (group.id)}
		<GroupRenderer {group} {warningGroupId} {warningMessage} />
	{/each}
</StepContainer>
