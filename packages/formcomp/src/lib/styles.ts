/** Shared Tailwind class strings for the built-in inputs. */

export const inputBase =
	'w-full rounded-(--form-radius) border border-(--form-border) bg-(--form-bg) px-3 py-2 text-sm shadow-xs transition-colors placeholder:text-(--form-muted) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--form-accent)/40 focus-visible:border-(--form-accent) disabled:cursor-not-allowed disabled:opacity-50';

export const labelBase = 'text-sm font-medium';

export const warningRing = 'ring-2 ring-(--form-error)/20 bg-(--form-error)/5';

export const warningField = 'border-(--form-error) ring-2 ring-(--form-error)/20';

/** Native radio/checkbox controls, tinted via accent-color. */
export const controlBase = 'size-4 shrink-0 cursor-pointer accent-(--form-accent)';

/** Visible keyboard-focus ring for labels wrapping sr-only radio inputs. */
export const optionFocus =
	'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-(--form-accent)/60 has-[:focus-visible]:ring-offset-2';
