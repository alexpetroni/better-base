import type { ChatMessage, ChatProvider, ChatStreamOptions } from './provider.ts';

/**
 * Deterministic keyword-based canned answers (ro) — enough to demo the advice
 * funnel without any network. Streaming is simulated by yielding word chunks.
 */
interface CannedAnswer {
	match: RegExp;
	reply: string;
}

const CANNED_ANSWERS: readonly CannedAnswer[] = [
	{
		match: /somn|insomni|dormi|adormi|obosit|obositoare/i,
		reply:
			'Pentru un somn mai bun, cele mai eficiente obiceiuri sunt: culcă-te și trezește-te ' +
			'la aceleași ore în fiecare zi, evită ecranele cu o oră înainte de culcare și ' +
			'păstrează dormitorul întunecat și răcoros. Dacă vrei o imagine clară a somnului tău, ' +
			'îți recomand testul nostru de evaluare a somnului din secțiunea de chestionare. ' +
			'Nu ofer sfaturi medicale — pentru probleme persistente, discută cu un medic.'
	},
	{
		match: /salut|bun[aă]\s*(ziua|seara)?|hei\b|hello/i,
		reply:
			'Salut! Sunt asistentul site-ului și te pot ajuta cu sfaturi practice pentru un stil ' +
			'de viață mai sănătos. Întreabă-mă orice — de exemplu, cum să dormi mai bine.'
	},
	{
		match: /test|chestionar|quiz|evaluare/i,
		reply:
			'Avem chestionare gratuite care îți arată unde te afli și ce poți îmbunătăți. ' +
			'Găsești testul de evaluare a somnului în secțiunea de chestionare — durează câteva ' +
			'minute și primești un scor cu recomandări personalizate.'
	}
];

const DEFAULT_REPLY =
	'Mulțumesc pentru întrebare! Te pot ajuta cu sfaturi despre obiceiuri sănătoase din ' +
	'ariile acoperite de acest site. Reformulează întrebarea sau încearcă unul dintre ' +
	'chestionarele noastre pentru recomandări personalizate. Reține: nu ofer sfaturi ' +
	'medicale — pentru orice problemă de sănătate, consultă un medic.';

/** Pure: the full canned reply for the latest user message. */
export function mockReplyFor(messages: ChatMessage[]): string {
	const lastUser = [...messages].reverse().find((m) => m.role === 'user');
	if (!lastUser) return DEFAULT_REPLY;
	const canned = CANNED_ANSWERS.find((c) => c.match.test(lastUser.content));
	return canned?.reply ?? DEFAULT_REPLY;
}

export function createMockChatProvider(): ChatProvider {
	return {
		kind: 'mock',
		async *stream(messages: ChatMessage[], options?: ChatStreamOptions) {
			// Word-sized chunks so streaming UIs render progressively.
			const reply = mockReplyFor(messages);
			for (const word of reply.split(/(?<= )/)) {
				// Client disconnected: stop like the real provider would.
				if (options?.signal?.aborted) return;
				yield word;
			}
		}
	};
}
