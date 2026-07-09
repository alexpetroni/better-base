import { error, fail } from '@sveltejs/kit';
import { PILLARS_BY_SLUG } from '$lib/config';
import { getDb } from '$lib/db';
import { EMAIL_TEMPLATE_KEYS } from '$lib/modules/email';
import {
	getQuiz,
	latestResultsWithEmail,
	publishQuiz,
	unpublishQuiz,
	updateQuiz,
	type QuizOpResult,
	type QuizPatch
} from '$lib/modules/quiz/server';
import { getSite } from '$lib/server/site';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const found = await getQuiz({ db: getDb() }, params.id);
	if (!found) error(404);

	const site = getSite();
	return {
		quiz: found.quiz,
		pillarSlug: found.pillarSlug,
		sitePillars: site.pillars.map((slug) => ({
			slug,
			name: PILLARS_BY_SLUG.get(slug)?.name ?? slug
		})),
		templateKeys: EMAIL_TEMPLATE_KEYS,
		results: await latestResultsWithEmail({ db: getDb() }, params.id)
	};
};

interface ParsedPatch {
	patch?: QuizPatch;
	failure?: { error: string; detail: string };
	/** Echoed back so a failed save never loses textarea edits. */
	echo: { formSchemaText: string; scoringText: string };
}

/** Both JSON editors must parse before anything is saved. */
function patchFrom(form: FormData): ParsedPatch {
	const formSchemaText = String(form.get('formSchema') ?? '');
	const scoringText = String(form.get('scoring') ?? '');
	const echo = { formSchemaText, scoringText };

	let formSchema: QuizPatch['formSchema'];
	try {
		formSchema = JSON.parse(formSchemaText);
	} catch (e) {
		return { failure: { error: 'json-form', detail: (e as Error).message }, echo };
	}
	let scoring: QuizPatch['scoring'];
	try {
		scoring = JSON.parse(scoringText);
	} catch (e) {
		return { failure: { error: 'json-scoring', detail: (e as Error).message }, echo };
	}

	return {
		patch: {
			title: String(form.get('title') ?? ''),
			slug: String(form.get('slug') ?? ''),
			introMd: String(form.get('introMd') ?? ''),
			pillarSlug: String(form.get('pillar') ?? '') || null,
			resultTemplateKey: String(form.get('resultTemplateKey') ?? '') || 'quiz-result',
			formSchema,
			scoring
		},
		echo
	};
}

function failOf(result: QuizOpResult<unknown> & { ok: false }, echo: ParsedPatch['echo']) {
	return fail(result.error === 'not-found' ? 404 : 400, {
		error: result.error,
		detail: result.detail ?? '',
		...echo
	});
}

async function saveFrom(request: Request, id: string) {
	const form = await request.formData();
	const { patch, failure, echo } = patchFrom(form);
	if (!patch) return { response: fail(400, { ...failure!, ...echo }) };
	const result = await updateQuiz({ db: getDb() }, id, patch);
	if (!result.ok) return { response: failOf(result, echo) };
	return { saved: result.value };
}

export const actions: Actions = {
	save: async ({ request, params }) => {
		const outcome = await saveFrom(request, params.id);
		if (outcome.response) return outcome.response;
		return { saved: true, slug: outcome.saved!.slug };
	},

	// Publish/unpublish also persist the current form so no edits are lost.
	publish: async ({ request, params }) => {
		const outcome = await saveFrom(request, params.id);
		if (outcome.response) return outcome.response;
		const result = await publishQuiz({ db: getDb() }, params.id);
		if (!result.ok) return failOf(result, { formSchemaText: '', scoringText: '' });
		return { saved: true, slug: result.value.slug };
	},

	unpublish: async ({ request, params }) => {
		const outcome = await saveFrom(request, params.id);
		if (outcome.response) return outcome.response;
		const result = await unpublishQuiz({ db: getDb() }, params.id);
		if (!result.ok) return failOf(result, { formSchemaText: '', scoringText: '' });
		return { saved: true, slug: result.value.slug };
	}
};
