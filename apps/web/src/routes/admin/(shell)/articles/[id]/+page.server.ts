import { error, fail } from '@sveltejs/kit';
import { PILLARS_BY_SLUG } from '$lib/config';
import { getDb } from '$lib/db';
import {
	getArticle,
	publishArticle,
	renderArticleHtml,
	unpublishArticle,
	updateArticle,
	type ArticlePatch,
	type BlogResult
} from '$lib/modules/blog/server';
import { getImgproxyConfig, imgSources } from '$lib/modules/media/server';
import { loadLibraryImages } from '$lib/server/media-library';
import { getSite } from '$lib/server/site';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const found = await getArticle({ db: getDb() }, params.id);
	if (!found) error(404);

	const site = getSite();
	const sitePillars = site.pillars.map((slug) => ({
		slug,
		name: PILLARS_BY_SLUG.get(slug)?.name ?? slug
	}));

	const library = await loadLibraryImages();

	return {
		article: found.article,
		pillarSlugs: found.pillarSlugs,
		coverThumb: found.cover?.key ? imgSources(found.cover, { w: 320, h: 200, fit: 'fill' }) : null,
		sitePillars,
		library
	};
};

function patchFrom(form: FormData): ArticlePatch {
	const cover = String(form.get('coverMediaId') ?? '');
	return {
		title: String(form.get('title') ?? ''),
		slug: String(form.get('slug') ?? ''),
		excerpt: String(form.get('excerpt') ?? ''),
		bodyMd: String(form.get('bodyMd') ?? ''),
		coverMediaId: cover || null,
		seoTitle: String(form.get('seoTitle') ?? ''),
		seoDescription: String(form.get('seoDescription') ?? ''),
		pillarSlugs: form.getAll('pillars').map(String)
	};
}

function failOf(result: BlogResult<unknown> & { ok: false }) {
	return fail(result.error === 'not-found' ? 404 : 400, {
		error: result.error,
		detail: result.detail ?? ''
	});
}

export const actions: Actions = {
	save: async ({ request, params }) => {
		const form = await request.formData();
		const result = await updateArticle({ db: getDb() }, params.id, patchFrom(form));
		if (!result.ok) return failOf(result);
		return { saved: true, slug: result.value.slug };
	},

	// Publish/unpublish also persist the current form so no edits are lost.
	publish: async ({ request, params }) => {
		const form = await request.formData();
		const saved = await updateArticle({ db: getDb() }, params.id, patchFrom(form));
		if (!saved.ok) return failOf(saved);
		const result = await publishArticle({ db: getDb() }, params.id);
		if (!result.ok) return failOf(result);
		return { saved: true, slug: result.value.slug };
	},

	unpublish: async ({ request, params }) => {
		const form = await request.formData();
		const saved = await updateArticle({ db: getDb() }, params.id, patchFrom(form));
		if (!saved.ok) return failOf(saved);
		const result = await unpublishArticle({ db: getDb() }, params.id);
		if (!result.ok) return failOf(result);
		return { saved: true, slug: result.value.slug };
	},

	// Render the CURRENT textarea content (not the saved one) for the preview pane.
	preview: async ({ request }) => {
		const form = await request.formData();
		const bodyMd = String(form.get('bodyMd') ?? '');
		const html = await renderArticleHtml({ db: getDb() }, getImgproxyConfig(), bodyMd);
		return { preview: html };
	}
};
