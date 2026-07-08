import { getContext } from 'svelte';
import { TRANSLATE_KEY, type TranslateFn } from './types.js';

/**
 * Resolve the form's translate function from context. Falls back to identity
 * when no translate fn was provided to MultiStepForm.
 * Must be called during component initialization.
 */
export function useTranslate(): (key: string) => string {
	const t = getContext<TranslateFn | undefined>(TRANSLATE_KEY);
	return (key: string) => (t ? t(key) : key);
}
