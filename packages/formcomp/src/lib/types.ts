// ── Condition System ──

export type ConditionOperator =
	| 'equals'
	| 'not-equals'
	| 'includes'
	| 'not-includes'
	| 'greater-than'
	| 'less-than'
	| 'answered'
	| 'not-answered';

export interface SimpleCondition {
	questionId: string;
	operator: ConditionOperator;
	/** Comparison value. Not used by 'answered' / 'not-answered'. */
	value?: unknown;
	/** Which step to look up the response in (for cross-step conditions) */
	stepId?: string;
}

export interface CompoundCondition {
	operator: 'and' | 'or';
	conditions: Condition[];
}

export type Condition = SimpleCondition | CompoundCondition;

// ── Question Types ──

export type QuestionType =
	| 'single-select'
	| 'multi-select'
	| 'select'
	| 'time-input'
	| 'date-input'
	| 'number-input'
	| 'range'
	| 'text-input'
	| 'textarea'
	| 'likert'
	| 'scale';

/** Answer value of a 'range' question: an inclusive from–to interval. */
export interface RangeValue {
	from?: number;
	to?: number;
}

export type DisplayVariant = 'list' | 'card';

export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
	exclusive?: boolean;
}

export interface LayoutHint {
	columns?: 1 | 2 | 3;
}

export interface Question {
	id: string;
	/**
	 * Stable identifier included in the submission payload. Assign it once and
	 * never change it — then labels, ids, and step placement can evolve while
	 * your backend keeps matching answers across quiz revisions. Falls back to
	 * `id` when omitted.
	 */
	uuid?: string;
	type: QuestionType;
	label: string;
	options?: QuestionOption[];
	required?: boolean;
	/** Extra help text shown as an info icon next to the label */
	tooltip?: string;
	min?: number;
	max?: number;
	step?: number;
	/** HTML input type for 'text-input' questions (default 'text') */
	inputType?: 'text' | 'email' | 'url';
	placeholder?: string;
	condition?: Condition;
	displayVariant?: DisplayVariant;
	layout?: LayoutHint;
	minLabel?: string;
	maxLabel?: string;
	rows?: number;
	unit?: string;
	/** Extra classes merged onto the question's root element */
	class?: string;
	/** Extra classes merged onto each option (select-type questions only) */
	optionClass?: string;
}

// ── Group & Step Config ──

export interface QuestionGroup {
	id: string;
	label: string;
	intro?: string;
	questions: Question[];
	condition?: Condition;
	renderMode?: 'individual' | 'likert-batch' | 'inline';
	layout?: LayoutHint;
	/** Extra classes merged onto the group wrapper */
	class?: string;
}

export interface StepConfig {
	id: string;
	label: string;
	intro?: string;
	groups: QuestionGroup[];
	/**
	 * Skip this entire step unless the condition is met. Conditions on a step
	 * should reference questions on other steps via `stepId`. Skipped steps are
	 * hidden from the progress header and excluded from navigation, validation,
	 * and the submitted responses.
	 */
	condition?: Condition;
	/** Extra classes merged onto the step container */
	class?: string;
}

export interface FormSettings {
	/** Show the step progress header. Default: true (hidden automatically when only one step is visible). */
	showProgress?: boolean;
	/**
	 * Allow navigating back to earlier steps. When false, both the Back button
	 * and clicking completed steps in the progress header are disabled.
	 * Default: true.
	 */
	allowBackNavigation?: boolean;
	/** Show a read-only summary of all answers (with edit links) before submitting. Default: false. */
	showSummary?: boolean;
	/** Heading of the summary screen (or i18n key). Default: 'Review your answers'. */
	summaryLabel?: string;
	/** Label of the per-step edit buttons on the summary screen (or i18n key). Default: 'Edit'. */
	editLabel?: string;
	/** Label for the next button (or i18n key). Default: 'Next'. */
	nextLabel?: string;
	/** Label for the back button (or i18n key). Default: 'Back'. */
	backLabel?: string;
	/** Label for the submit button on the last step (or i18n key). Default: 'Submit'. */
	submitLabel?: string;
	/** Message shown on the first incomplete group when a required answer is missing (or i18n key). */
	requiredMessage?: string;
	/** Message shown when an answer is present but invalid, e.g. out of range (or i18n key). */
	invalidMessage?: string;
	/** Heading of the built-in success screen (or i18n key). Default: 'Thank you!'. A `title` in the server response takes precedence. */
	successTitle?: string;
	/** Body of the built-in success screen (or i18n key). Default: 'Your answers have been submitted.'. A `message` in the server response takes precedence. */
	successMessage?: string;
	/** Message shown when the POST fails (or i18n key). Server-provided error messages take precedence. */
	submitErrorMessage?: string;
}

export interface FormConfig {
	steps: StepConfig[];
	settings?: FormSettings;
	/**
	 * Version stamp of this config. Included in the submission payload and used
	 * to invalidate persisted in-progress answers from older config versions.
	 */
	version?: string | number;
	/** When set, the form POSTs the results to this endpoint on submit. */
	submit?: SubmitConfig;
	/** Extra classes merged onto the form's root element */
	class?: string;
}

// ── Submission ──

export interface SubmitConfig {
	/** Endpoint that receives the results as a JSON POST */
	url: string;
	/** Extra request headers (e.g. auth) */
	headers?: Record<string, string>;
	/**
	 * Navigate here after a successful submission (e.g. a subscription or
	 * results page). A `redirectUrl` in the server's JSON response takes
	 * precedence. When neither is set, a built-in success screen replaces the
	 * form in place.
	 */
	successUrl?: string;
}

export interface SubmitAnswer {
	/** Stable question identifier: `question.uuid`, falling back to `question.id` */
	uuid: string;
	questionId: string;
	stepId: string;
	type: QuestionType;
	/** Translated question label at the time of submission */
	label: string;
	/** Raw answer value */
	value: unknown;
	/** Human-readable answer (option labels, formatted ranges/units) */
	displayValue: string;
}

export interface SubmitPayload {
	form: {
		version?: string | number;
		submittedAt: string;
	};
	answers: SubmitAnswer[];
}

// ── Translation ──

export type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

// ── State Adapter ──

export interface FormStateAdapter {
	getResponse(stepId: string, questionId: string): unknown;
	setResponse(stepId: string, questionId: string, value: unknown): void;
	getStepResponses(stepId: string): Record<string, unknown>;
}

/** A FormStateAdapter that also owns step navigation — what MultiStepForm needs. */
export interface FormStateController extends FormStateAdapter {
	currentStepIndex: number;
	nextStep(): void;
	prevStep(): void;
	goToStep(index: number): void;
}

// ── Callbacks ──

export interface FormCallbacks {
	onStepComplete?: (stepId: string, stepIndex: number) => void;
	onFormComplete?: (allResponses: Record<string, Record<string, unknown>>) => void;
	onStepChange?: (fromIndex: number, toIndex: number) => void;
	/** Fired after the configured POST succeeds (2xx). `response` is the parsed JSON body, or null. */
	onSubmitSuccess?: (payload: SubmitPayload, response: unknown) => void;
	/** Fired when the configured POST fails (network error or non-2xx). */
	onSubmitError?: (error: unknown) => void;
}

// ── Context Keys ──

export const FORM_STATE_KEY = Symbol('form-state');
export const TRANSLATE_KEY = Symbol('form-translate');
export const STEP_ID_KEY = Symbol('form-step-id');
