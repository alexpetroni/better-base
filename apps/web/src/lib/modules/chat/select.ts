/**
 * Provider selection, pure so it is unit-testable offline. Mock is the
 * default; Anthropic requires BOTH `CHAT_PROVIDER=anthropic` AND a non-empty
 * `ANTHROPIC_API_KEY` — a missing key is a boot error, never a silent
 * fallback that could hide a misconfigured production deployment.
 */
export interface ChatProviderEnv {
	CHAT_PROVIDER?: string;
	ANTHROPIC_API_KEY?: string;
}

export type ChatProviderSelection = { kind: 'mock' } | { kind: 'anthropic'; apiKey: string };

export function selectChatProvider(env: ChatProviderEnv): ChatProviderSelection {
	const requested = env.CHAT_PROVIDER?.trim() || 'mock';
	if (requested === 'mock') return { kind: 'mock' };
	if (requested === 'anthropic') {
		const apiKey = env.ANTHROPIC_API_KEY?.trim();
		if (!apiKey) {
			throw new Error('CHAT_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set');
		}
		return { kind: 'anthropic', apiKey };
	}
	throw new Error(`Unknown CHAT_PROVIDER "${requested}". Expected "mock" or "anthropic".`);
}
