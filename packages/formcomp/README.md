# formComp

Config-driven multi-step form component library for Svelte 5. Define your entire form as a JSON config object and let the library handle rendering, validation, conditional logic, and navigation.

Built with SvelteKit, TypeScript, and Tailwind CSS v4.

## Installation

```sh
npm install github:alexpetroni/general-form-comp
```

**Prerequisite:** Your Svelte project must have [Tailwind CSS v4](https://tailwindcss.com/docs/installation/using-vite) configured, since the components use Tailwind utility classes.

Then in your app CSS, tell Tailwind to scan the library (v4 skips `node_modules` by default) and import the theme tokens:

```css
@import 'tailwindcss';
@import 'formcomp/theme.css';
@source '../node_modules/formcomp/dist';
```

(Adjust the `@source` path so it is relative to your CSS file.)

## Usage

```svelte
<script lang="ts">
  import { MultiStepForm } from 'formcomp';
  import type { FormConfig, FormCallbacks } from 'formcomp';

  const config: FormConfig = {
    steps: [
      {
        id: 'step-1',
        label: 'Basic Info',
        groups: [
          {
            id: 'name-group',
            label: 'Your Name',
            questions: [
              {
                id: 'full_name',
                type: 'text-input',
                label: 'Full name',
                required: true,
                placeholder: 'Jane Doe'
              }
            ]
          }
        ]
      }
    ]
  };

  const callbacks: FormCallbacks = {
    onFormComplete(responses) {
      console.log(responses);
    }
  };
</script>

<MultiStepForm {config} {callbacks} />
```

### Development

To run the demo/dev sandbox locally:

```sh
git clone git@github.com:alexpetroni/general-form-comp.git
cd general-form-comp
npm install
npm run dev
```

Visit `http://localhost:5173` to see the demo form, and `http://localhost:5173/examples` for the full example gallery.

Unit tests (condition evaluator, validator, config checks) run with Vitest; browser tests (step skipping, conditional show/hide, answer clearing, validation, summary, submission payload) run with Playwright against a production preview build:

```sh
npm run test:unit
npx playwright install chromium   # once
npm run test:e2e
```

Both run in CI on every push (`.github/workflows/ci.yml`).

### Examples

Ready-to-run `FormConfig` objects live in the `./src/examples/` directory. Each one is paired with a route under `/examples/<slug>`:

| Slug | File | What it shows |
|------|------|---------------|
| `minimal` | `src/examples/minimal.ts` | Smallest useful form, plus result submission: `submit` config, question `uuid`s, success screen, error handling. |
| `conditional` | `src/examples/conditional.ts` | `and`/`or` conditions, cross-step visibility, step-level skipping, `greater-than` and `answered` operators. |
| `likert` | `src/examples/likert.ts` | A `likert-batch` group with a shared option set. |
| `all-inputs` | `src/examples/all-inputs.ts` | Every built-in input type, `tooltip`, `inputType: 'email'`, group `intro`, and the summary screen. |
| `customized` | `src/examples/customized.ts` | All `settings` labels/messages, summary customization, and `class`/`optionClass` styling hooks. |
| `kiosk` | `src/examples/kiosk.ts` | Linear one-way flow: `showProgress: false`, `allowBackNavigation: false`. |
| `sleep-assessment` | `src/examples/sleep-assessment.ts` | Larger three-step form combining everything. |

Drop a new `.ts` file into `./src/examples/`, add it to `src/examples/index.ts`, and it will show up in the `/examples` gallery automatically.

### Props

| Prop | Type | Description |
|------|------|-------------|
| `config` | `FormConfig` | The form configuration object (required). Captured once at mount — to swap configs at runtime, re-create the component with `{#key}`. |
| `translate` | `TranslateFn` | Optional `(key, params?) => string` for i18n. When provided, all `label` fields are treated as translation keys. When omitted, labels render as-is. |
| `state` | `FormStateController` | Optional external state controller (`FormStateAdapter` + step navigation). If omitted, an internal one is created with sessionStorage persistence. |
| `callbacks` | `FormCallbacks` | Optional lifecycle callbacks. |
| `success` | `Snippet<[SubmitPayload, unknown]>` | Optional custom success screen rendered after a successful POST (see "Submitting results"). |

### i18n

Pass a `translate` function and *every* string in the config — question and option labels, tooltips, intros, settings labels and messages — is treated as a translation key:

```svelte
<script>
  import { t } from './my-i18n.js'; // svelte-i18n, paraglide, or your own

  const config = {
    settings: { nextLabel: 'form.next', submitLabel: 'form.submit' },
    steps: [{ id: 's1', label: 'step.basics', groups: [/* label: 'q.name', … */] }]
  };
</script>

<MultiStepForm {config} translate={(key) => t(key)} />
```

Without `translate`, all strings render as-is — plain-English configs need no setup. The built-in defaults ('Next', 'Back', 'Submit', validation and success messages) are also passed through `translate`, so provide keys via `settings` or translations for the default English strings.

### Callbacks

```ts
interface FormCallbacks {
  onStepComplete?: (stepId: string, stepIndex: number) => void;
  onFormComplete?: (allResponses: Record<string, Record<string, unknown>>) => void;
  onStepChange?: (fromIndex: number, toIndex: number) => void;
  onSubmitSuccess?: (payload: SubmitPayload, response: unknown) => void; // after a 2xx POST
  onSubmitError?: (error: unknown) => void;                              // network error or non-2xx
}
```

### State management

The built-in state manager persists responses to sessionStorage by default:

```ts
import { createFormState } from 'formcomp';

const state = createFormState(config, {
  persist: 'localStorage',  // 'sessionStorage' (default) | 'localStorage' | false
  storageKey: 'my-form',    // default: 'formcomp-state'
  debounceMs: 500,          // default: 300
  version: 3                // bump when the config changes shape — persisted
                            // state from other versions is discarded
});
```

You can also provide your own state by implementing the `FormStateAdapter` interface:

```ts
interface FormStateAdapter {
  getResponse(stepId: string, questionId: string): unknown;
  setResponse(stepId: string, questionId: string, value: unknown): void;
  getStepResponses(stepId: string): Record<string, unknown>;
}
```

---

## Styling & theming

The components have **no dependency on any design system** — they are styled with Tailwind utilities driven by a small set of `--form-*` CSS variables, scoped to the `.formcomp` class that `MultiStepForm` renders on its root element.

### Theme variables

Override any of them in your own CSS to retheme the whole form:

```css
.formcomp {
	--form-accent: oklch(0.55 0.2 150);   /* selected states, buttons, progress */
	--form-accent-foreground: white;       /* text on accent surfaces */
	--form-bg: white;                      /* input & card backgrounds */
	--form-fg: #1a1a2e;                    /* base text color */
	--form-muted: #6b7280;                 /* descriptions, secondary text */
	--form-border: #e5e7eb;                /* borders & separators */
	--form-error: #dc2626;                 /* validation warning ring */
	--form-radius: 0.625rem;               /* corner radius */
}
```

When using input components standalone (outside `MultiStepForm`), wrap them in an element with `class="formcomp"` so the variables apply.

### Per-config class hooks

Every level of the config accepts extra Tailwind classes, merged onto the defaults with `tailwind-merge` (so your classes win on conflict):

```ts
const config: FormConfig = {
	class: 'max-w-2xl',                     // form root
	steps: [{
		id: 'basics',
		label: 'Basics',
		class: 'space-y-12',                  // step container
		groups: [{
			id: 'main',
			label: 'Main',
			class: 'rounded-xl border p-6',     // group wrapper
			questions: [{
				id: 'concern',
				type: 'single-select',
				label: 'Pick one',
				class: 'md:col-span-2',           // question root
				optionClass: 'border-dashed',     // each option (select-type questions)
				options: [/* ... */]
			}]
		}]
	}]
};
```

Because the config lives in *your* project source, your Tailwind build scans it and generates whatever classes you use — no extra setup.

## Config format

A form config is a tree: **FormConfig > StepConfig[] > QuestionGroup[] > Question[]**.

### FormConfig

The root object.

```ts
interface FormConfig {
  steps: StepConfig[];
  settings?: FormSettings;
  version?: string | number;  // config version: stamped into the payload, invalidates persisted answers
  submit?: SubmitConfig;      // POST the results to an endpoint (see "Submitting results")
  class?: string;   // extra Tailwind classes on the form root
}
```

### FormSettings

Form-wide behavior switches, all optional:

```ts
interface FormSettings {
  showProgress?: boolean;        // show the step header (default true)
  allowBackNavigation?: boolean; // when false, hides the Back button AND disables header clicks (default true)
  showSummary?: boolean;         // read-only recap with edit links before submit (default false)
  summaryLabel?: string;         // summary heading, default 'Review your answers'
  editLabel?: string;            // summary edit-button label, default 'Edit'
  nextLabel?: string;            // default 'Next'
  backLabel?: string;            // default 'Back'
  submitLabel?: string;          // default 'Submit'
  requiredMessage?: string;      // message when a required answer is missing
  invalidMessage?: string;       // message when an answer is out of range / invalid
  successTitle?: string;         // built-in success screen heading, default 'Thank you!'
  successMessage?: string;       // built-in success screen body
  submitErrorMessage?: string;   // shown when the POST fails (server messages win)
}
```

All labels are passed through the `translate` function when one is provided.

### StepConfig

Each step is one page/screen in the multi-step flow.

```ts
interface StepConfig {
  id: string;       // unique step identifier
  label: string;    // displayed in the progress bar
  intro?: string;   // optional paragraph shown below the step title
  groups: QuestionGroup[];
  condition?: Condition;  // skip the entire step unless met (reference other steps via stepId)
  class?: string;   // extra Tailwind classes on the step container
}
```

A step with an unmet `condition` is **skipped entirely**: it disappears from the progress header, Next/Back jump over it, and its questions are excluded from validation and from the submitted responses.

### QuestionGroup

Groups organize questions under a heading. They are the unit of validation feedback (the first incomplete group gets highlighted).

```ts
interface QuestionGroup {
  id: string;        // unique within the step
  label: string;     // group heading
  intro?: string;    // optional paragraph below the heading
  questions: Question[];
  condition?: Condition;   // hide the entire group unless condition is met
  renderMode?: 'individual' | 'likert-batch' | 'inline';
  layout?: LayoutHint;
  class?: string;          // extra Tailwind classes on the group wrapper
}
```

**`renderMode`** controls how the questions inside the group are rendered:

| Mode | Behavior |
|------|----------|
| `'individual'` | (default) Each question renders in its own space with individual warning states. |
| `'likert-batch'` | All questions are passed to a single `LikertGroup` component as a batch table. All questions must share the same `options` array. |
| `'inline'` | All questions render sequentially inside a single wrapper. Useful with `layout.columns` for side-by-side fields. |

### Question

The individual form field.

```ts
interface Question {
  id: string;         // unique within the step, used as the response key
  uuid?: string;      // stable id for the submission payload — assign once, never change,
                      // then labels/ids/steps can evolve without breaking your backend
  type: QuestionType;
  label: string;      // field label (or i18n key when translate fn is provided)
  required?: boolean;  // if true, validation blocks progression when empty
  options?: QuestionOption[];
  condition?: Condition;
  // Display
  displayVariant?: 'list' | 'card';  // for single-select only
  layout?: LayoutHint;
  // Number/scale
  min?: number;
  max?: number;
  step?: number;       // for time-input: rounding interval in seconds (e.g. 900 = 15 min)
  minLabel?: string;   // label under the low end of a scale
  maxLabel?: string;   // label under the high end of a scale
  unit?: string;       // suffix shown inside number inputs (e.g. "kg", "min")
  // Text
  placeholder?: string;
  rows?: number;       // for textarea
  inputType?: 'text' | 'email' | 'url';  // for text-input
  tooltip?: string;    // help text shown as an info icon next to the label
  // Styling
  class?: string;       // extra Tailwind classes on the question root
  optionClass?: string; // extra Tailwind classes on each option (select-type questions)
}
```

### QuestionType

| Type | Component | Value type | Notes |
|------|-----------|------------|-------|
| `'single-select'` | `RadioListGroup` or `RadioCardGroup` | `string` | Use `displayVariant: 'card'` for card layout. Requires `options`. |
| `'multi-select'` | `CheckboxGroup` | `string[]` | Requires `options`. Supports `exclusive` options. |
| `'select'` | `SelectInput` | `string` | Native dropdown, good for long option lists. Requires `options`; `placeholder` is the empty first option. |
| `'likert'` | `LikertGroup` | `string` | Designed for use inside a group with `renderMode: 'likert-batch'`. Requires `options`. |
| `'scale'` | `ScaleInput` | `number` | Numbered circular buttons. Uses `min`/`max` (default 1-10), `minLabel`/`maxLabel`. |
| `'time-input'` | `TimeInput` | `string` | HTML time input. `step` is in seconds (900 = 15-minute rounding). |
| `'date-input'` | `DateInput` | `string` | HTML date input, ISO `YYYY-MM-DD`. |
| `'number-input'` | `NumberInput` | `number` | Supports `min`, `max`, `step`, `unit`, `placeholder`. |
| `'range'` | `RangeInput` | `{ from, to }` | A from–to interval as two number fields. `min`/`max` bound both ends; `minLabel`/`maxLabel` label the fields (default From/To); supports `step`, `unit`. Half-filled or inverted ranges fail validation. |
| `'text-input'` | `TextInput` | `string` | Plain text field. Supports `placeholder` and `inputType: 'email' \| 'url'`. |
| `'textarea'` | `TextArea` | `string` | Multi-line. Supports `rows` (default 4), `placeholder`. |

### QuestionOption

Used by `single-select`, `multi-select`, and `likert` question types.

```ts
interface QuestionOption {
  value: string;        // stored as the response value
  label: string;        // display text (or i18n key)
  description?: string; // secondary text shown below the label
  exclusive?: boolean;  // multi-select only: selecting this deselects all others
}
```

### LayoutHint

Controls grid layout within a group or for a specific question.

```ts
interface LayoutHint {
  columns?: 1 | 2 | 3;   // render in a CSS grid with this many columns
}
```

Applied on a **group** with `renderMode: 'inline'`, this places all the group's questions into a multi-column grid:

```ts
{
  id: 'body-metrics',
  label: 'Body Metrics',
  renderMode: 'inline',
  layout: { columns: 2 },
  questions: [
    { id: 'height', type: 'number-input', label: 'Height', unit: 'cm' },
    { id: 'weight', type: 'number-input', label: 'Weight', unit: 'kg' }
  ]
}
```

### Condition

Conditions control visibility of groups and questions. A hidden question is also excluded from validation.

#### Simple condition

Show this item when a specific question has (or doesn't have) a specific value:

```ts
interface SimpleCondition {
  questionId: string;
  operator: ConditionOperator;
  value?: unknown;   // not used by 'answered' / 'not-answered'
  stepId?: string;   // look up the response in a different step (for cross-step conditions)
}
```

| Operator | Behavior |
|----------|----------|
| `'equals'` | `response === value` (strict — a `scale` answer is a `number`, so compare with a number) |
| `'not-equals'` | `response !== value` |
| `'includes'` | `Array.isArray(response) && response.includes(value)` |
| `'not-includes'` | `!Array.isArray(response) \|\| !response.includes(value)` |
| `'greater-than'` | both response and value are numbers, and `response > value` |
| `'less-than'` | both response and value are numbers, and `response < value` |
| `'answered'` | response is present and non-empty |
| `'not-answered'` | response is missing or empty |

#### Compound condition

Combine multiple conditions with AND/OR:

```ts
interface CompoundCondition {
  operator: 'and' | 'or';
  conditions: Condition[];   // can nest SimpleCondition or CompoundCondition
}
```

#### Examples

Show a question only when another answer is not "no":

```ts
{
  id: 'restless_relief',
  type: 'single-select',
  label: 'Does moving help?',
  condition: {
    questionId: 'restless_legs',
    operator: 'not-equals',
    value: 'no'
  },
  options: [...]
}
```

Show a group only when a question on a different step equals "female":

```ts
{
  id: 'hormonal',
  label: 'Hormonal Factors',
  condition: {
    questionId: 'biological_sex',
    operator: 'equals',
    value: 'female',
    stepId: 'physical'
  },
  questions: [...]
}
```

Compound condition (show when user selected "coffee" AND frequency is "daily"):

```ts
{
  condition: {
    operator: 'and',
    conditions: [
      { questionId: 'beverages', operator: 'includes', value: 'coffee' },
      { questionId: 'coffee_frequency', operator: 'equals', value: 'daily' }
    ]
  }
}
```

---

## Full example

A three-step form demonstrating all question types, conditional logic, layout, and Likert batches:

```ts
const config: FormConfig = {
  steps: [
    {
      id: 'basics',
      label: 'Basics',
      intro: 'Some introductory text.',
      groups: [
        {
          id: 'schedule',
          label: 'Daily Schedule',
          renderMode: 'inline',
          layout: { columns: 2 },
          questions: [
            { id: 'wake', type: 'time-input', label: 'Wake time', required: true, step: 900 },
            { id: 'sleep', type: 'time-input', label: 'Sleep time', required: true, step: 900 }
          ]
        },
        {
          id: 'main-issue',
          label: 'Primary Concern',
          questions: [
            {
              id: 'concern',
              type: 'single-select',
              label: 'What brings you here?',
              displayVariant: 'card',
              required: true,
              options: [
                { value: 'a', label: 'Option A', description: 'Description for A' },
                { value: 'b', label: 'Option B', description: 'Description for B' },
                { value: 'other', label: 'Other', description: 'Something else' }
              ]
            }
          ]
        },
        {
          id: 'other-details',
          label: 'Details',
          condition: { questionId: 'concern', operator: 'equals', value: 'other' },
          questions: [
            { id: 'details', type: 'textarea', label: 'Please describe', required: true, rows: 3 }
          ]
        }
      ]
    },
    {
      id: 'ratings',
      label: 'Severity',
      groups: [
        {
          id: 'severity-scale',
          label: 'How severe is the issue?',
          questions: [
            {
              id: 'severity',
              type: 'scale',
              label: 'Overall severity',
              required: true,
              min: 1,
              max: 10,
              minLabel: 'Not at all',
              maxLabel: 'Extremely'
            }
          ]
        },
        {
          id: 'frequency-ratings',
          label: 'Rate frequency over the past 2 weeks',
          renderMode: 'likert-batch',
          questions: [
            {
              id: 'freq_1', type: 'likert', label: 'Symptom A', required: true,
              options: [
                { value: '0', label: 'Never' },
                { value: '1', label: 'Rarely' },
                { value: '2', label: 'Sometimes' },
                { value: '3', label: 'Often' }
              ]
            },
            {
              id: 'freq_2', type: 'likert', label: 'Symptom B', required: true,
              options: [
                { value: '0', label: 'Never' },
                { value: '1', label: 'Rarely' },
                { value: '2', label: 'Sometimes' },
                { value: '3', label: 'Often' }
              ]
            }
          ]
        }
      ]
    },
    {
      id: 'profile',
      label: 'Profile',
      groups: [
        {
          id: 'demographics',
          label: 'About You',
          renderMode: 'inline',
          layout: { columns: 2 },
          questions: [
            { id: 'age', type: 'number-input', label: 'Age', required: true, min: 13, max: 120 },
            { id: 'height', type: 'number-input', label: 'Height', required: true, unit: 'cm' }
          ]
        },
        {
          id: 'habits',
          label: 'Daily Habits',
          questions: [
            {
              id: 'activities',
              type: 'multi-select',
              label: 'Select all that apply',
              required: true,
              options: [
                { value: 'exercise', label: 'Exercise' },
                { value: 'meditation', label: 'Meditation' },
                { value: 'reading', label: 'Reading' },
                { value: 'none', label: 'None of the above', exclusive: true }
              ]
            }
          ]
        }
      ]
    }
  ]
};
```

## Submitting results

Set `config.submit` and the form POSTs the results as JSON when the user submits (after the summary screen, when enabled):

```ts
const config: FormConfig = {
  version: 3,
  submit: {
    url: 'https://api.example.com/quiz-results',
    headers: { authorization: 'Bearer …' },  // optional
    successUrl: '/subscribe'                  // optional: navigate here on success
  },
  steps: [/* … */]
};
```

### Payload

Each answer carries the question's **stable `uuid`** (falling back to `id`), the raw value, and a human-readable `displayValue`. Key your backend on `uuid` and the quiz can be reworded, reordered, and restructured without breaking old data:

```json
{
  "form": { "version": 3, "submittedAt": "2026-07-02T10:00:00.000Z" },
  "answers": [
    {
      "uuid": "3f1c2d84-…",
      "questionId": "traveling",
      "stepId": "travel",
      "type": "single-select",
      "label": "Are you planning to travel this year?",
      "value": "yes",
      "displayValue": "Yes"
    }
  ]
}
```

Only currently visible answers are included (same rules as `onFormComplete`). `buildSubmitPayload(config, getResponse, translate?)` is exported if you want to build the payload yourself.

### After a successful POST

In order of precedence:

1. **`redirectUrl` in the server's JSON response** — the browser navigates there. Use this when the follow-up depends on the submission (e.g. a personalized results page).
2. **`submit.successUrl` from the config** — same navigation, statically configured. Ideal for a subscription/results page that needs its own layout.
3. **Built-in success screen** — replaces the form in place, inside the same themed container, so it works in any host page. Text comes from `title`/`message` in the server response, else `settings.successTitle`/`successMessage`.

For a fully custom in-place result view, pass a `success` snippet:

```svelte
<MultiStepForm {config}>
  {#snippet success(payload, response)}
    <ScoreCard score={response.score} />
  {/snippet}
</MultiStepForm>
```

### Errors

A failed POST (network error or non-2xx) shows a `role="alert"` message — the server's `message` field when present, else `settings.submitErrorMessage` — and re-enables Submit for a retry. Answers are never lost. The Submit button is disabled while a request is in flight.

Two callbacks report the outcome: `onSubmitSuccess(payload, response)` and `onSubmitError(error)`. `onFormComplete` still fires when the user submits, before the POST.

## Response format

When `onFormComplete` fires, responses are keyed by step ID, then question ID:

```ts
{
  "basics": {
    "wake": "07:00",
    "sleep": "23:00",
    "concern": "other",
    "details": "I have trouble with..."
  },
  "ratings": {
    "severity": 7,
    "freq_1": "2",
    "freq_2": "1"
  },
  "profile": {
    "age": 34,
    "height": 175,
    "activities": ["exercise", "reading"]
  }
}
```

## Validation

Validation runs automatically when the user clicks "Next". The validator:

1. Walks all groups and questions in the current step's config.
2. Skips any group or question hidden by a `condition`.
3. For each visible question with `required: true`, checks that a response exists and is non-empty.
4. For answered `number-input` / `scale` questions, checks the value is within `min`/`max`. For `range` questions, both ends must be filled, within bounds, and not inverted.
5. If invalid, highlights the first failing group (red ring, smooth scroll) and shows an error message via `role="alert"` — `settings.requiredMessage` for missing answers, `settings.invalidMessage` for out-of-range ones.

No hand-coded validation arrays are needed. The config is the single source of truth.

### Hidden answers

When a question becomes hidden by a condition, its stored answer is cleared, so stale values can't keep dependent conditions alive. On submit, `onFormComplete` receives only the responses of currently visible steps, groups, and questions (via `collectResponses`) — the payload always matches what the user saw.

### Config sanity checks

In dev mode, `MultiStepForm` runs `validateConfig(config)` and logs warnings for duplicate ids, select questions without options, mismatched `likert-batch` option sets, conditions referencing unknown questions or steps, and comparison operators missing a `value`. You can also call `validateConfig` yourself (e.g. in a unit test for your configs).

## Project structure

```
src/lib/
  index.ts                          # barrel export
  types.ts                          # full type system
  state/form-state.svelte.ts        # reactive state with persistence
  conditions/evaluator.ts           # condition evaluation engine
  validation/validator.ts           # config-driven validation
  components/
    core/
      MultiStepForm.svelte          # top-level orchestrator
      FormStep.svelte               # renders one step from config
      GroupRenderer.svelte           # renders a group (handles renderMode, conditions, layout)
      QuestionRenderer.svelte        # maps question type to input component
    inputs/
      RadioListGroup.svelte          # single-select vertical list
      RadioCardGroup.svelte          # single-select card grid
      CheckboxGroup.svelte           # multi-select with exclusive option logic
      LikertGroup.svelte             # likert-scale batch table
      ScaleInput.svelte              # numbered 1-N circular buttons
      TimeInput.svelte               # time picker with step rounding
      NumberInput.svelte             # number with min/max/unit
      TextInput.svelte               # text/email/url
      TextArea.svelte                # multi-line text
    layout/
      ProgressBar.svelte             # horizontal step indicator with arrows
      NavigationButtons.svelte       # back/next buttons
      StepContainer.svelte           # step title + intro wrapper
      QuestionGroupWrapper.svelte    # group heading + warning ring
src/routes/
  +page.svelte                      # demo page
```

## Exports

Everything is available from `'formcomp'`:

```ts
import { MultiStepForm, createFormState, evaluateCondition, validateStep, collectResponses, validateConfig } from 'formcomp';
import type { FormConfig, Question, Condition } from 'formcomp';
```

- **Components**: `MultiStepForm`, `FormStep`, `QuestionRenderer`, `GroupRenderer`, `SummaryStep`, all 12 input components (+ `FieldLabel`), all 4 layout components
- **State**: `createFormState`
- **Utilities**: `evaluateCondition`, `isAnswered`, `validateStep`, `questionStatus`, `isStepVisible`, `collectResponses`, `validateConfig`, `buildSubmitPayload`, `formatAnswer`, `useTranslate`
- **Types**: `FormConfig`, `FormSettings`, `SubmitConfig`, `SubmitAnswer`, `SubmitPayload`, `StepConfig`, `QuestionGroup`, `Question`, `QuestionOption`, `RangeValue`, `Condition`, `SimpleCondition`, `CompoundCondition`, `ConditionOperator`, `QuestionType`, `DisplayVariant`, `LayoutHint`, `TranslateFn`, `FormStateAdapter`, `FormStateController`, `FormStateOptions`, `FormCallbacks`
- **Context keys**: `FORM_STATE_KEY`, `TRANSLATE_KEY`, `STEP_ID_KEY`
