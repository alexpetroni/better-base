export interface Persona {
	/** Matches a site config's `chatPersonaKey`. */
	key: string;
	/**
	 * Builds the ro system prompt. The site name is interpolated at runtime —
	 * brand strings may only live in `config/sites/*`.
	 */
	systemPrompt(input: { siteName: string }): string;
}
