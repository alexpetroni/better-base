/**
 * Romanian API-facing copy for /api/chat error responses (the widget renders
 * these verbatim). UI labels live in paraglide messages; these mirror the
 * email-template convention of ro copy in module code.
 */
export const CHAT_ERRORS = {
	invalid: 'Mesajul nu a putut fi procesat. Încearcă din nou.',
	empty: 'Scrie un mesaj înainte de a trimite.',
	'too-long': 'Mesajul este prea lung — maximum 2000 de caractere.',
	forbidden: 'Sesiunea de conversație nu este validă. Începe o conversație nouă.',
	rateLimited:
		'Ai trimis prea multe mesaje într-un timp scurt. Ia o pauză și revino peste o oră — între timp poți explora articolele și chestionarele noastre.',
	stream: 'S-a întrerupt răspunsul. Încearcă din nou.'
} as const;
