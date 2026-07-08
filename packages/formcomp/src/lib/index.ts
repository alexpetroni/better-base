// Core components
export { default as MultiStepForm } from './components/core/MultiStepForm.svelte';
export { default as FormStep } from './components/core/FormStep.svelte';
export { default as QuestionRenderer } from './components/core/QuestionRenderer.svelte';
export { default as GroupRenderer } from './components/core/GroupRenderer.svelte';
export { default as SummaryStep } from './components/core/SummaryStep.svelte';

// Input components
export { default as RadioListGroup } from './components/inputs/RadioListGroup.svelte';
export { default as RadioCardGroup } from './components/inputs/RadioCardGroup.svelte';
export { default as CheckboxGroup } from './components/inputs/CheckboxGroup.svelte';
export { default as SelectInput } from './components/inputs/SelectInput.svelte';
export { default as LikertGroup } from './components/inputs/LikertGroup.svelte';
export { default as ScaleInput } from './components/inputs/ScaleInput.svelte';
export { default as TimeInput } from './components/inputs/TimeInput.svelte';
export { default as DateInput } from './components/inputs/DateInput.svelte';
export { default as NumberInput } from './components/inputs/NumberInput.svelte';
export { default as RangeInput } from './components/inputs/RangeInput.svelte';
export { default as TextInput } from './components/inputs/TextInput.svelte';
export { default as TextArea } from './components/inputs/TextArea.svelte';
export { default as FieldLabel } from './components/inputs/FieldLabel.svelte';

// Layout components
export { default as ProgressBar } from './components/layout/ProgressBar.svelte';
export { default as NavigationButtons } from './components/layout/NavigationButtons.svelte';
export { default as StepContainer } from './components/layout/StepContainer.svelte';
export { default as QuestionGroupWrapper } from './components/layout/QuestionGroupWrapper.svelte';

// State
export { createFormState, type FormStateOptions } from './state/form-state.svelte.js';

// Condition & Validation
export { evaluateCondition, isAnswered } from './conditions/evaluator.js';
export { validateStep, questionStatus, isStepVisible, collectResponses } from './validation/validator.js';
export { validateConfig } from './validation/config-check.js';

// Submission
export { buildSubmitPayload } from './submission.js';
export { formatAnswer } from './format.js';

// i18n
export { useTranslate } from './i18n.js';

// Types
export type {
	Condition,
	SimpleCondition,
	CompoundCondition,
	ConditionOperator,
	QuestionType,
	DisplayVariant,
	QuestionOption,
	RangeValue,
	LayoutHint,
	Question,
	QuestionGroup,
	StepConfig,
	FormConfig,
	FormSettings,
	SubmitConfig,
	SubmitAnswer,
	SubmitPayload,
	TranslateFn,
	FormStateAdapter,
	FormStateController,
	FormCallbacks
} from './types.js';

export { FORM_STATE_KEY, TRANSLATE_KEY, STEP_ID_KEY } from './types.js';
