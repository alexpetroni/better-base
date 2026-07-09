import { error } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import {
	getArticle,
	publishArticle,
	renderArticleHtml,
	unpublishArticle,
	updateArticle,
	type ArticlePatch
} from '$lib/modules/blog/server';
import { getImgproxyConfig, imgSources } from '$lib/modules/media/server';
import { failResult, formStr, formStrAll } from '$lib/server/forms';
import { loadLibraryImages } from '$lib/server/media-library';
import { resolveSitePillars } from '$lib/server/site';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const found = await getArticle({ db: getDb() }, params.id);
	if (!found) error(404);

	const sitePillars = resolveSitePillars();
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
	return {
		title: formStr(form, 'title'),
		slug: formStr(form, 'slug'),
		excerpt: formStr(form, 'excerpt'),
		bodyMd: formStr(form, 'bodyMd'),
		coverMediaId: formStr(form, 'coverMediaId') || null,
		seoTitle: formStr(form, 'seoTitle'),
		seoDescription: formStr(form, 'seoDescription'),
		pillarSlugs: formStrAll(form, 'pillars')
	};
}

export const actions: Actions = {
	save: async ({ request, params }) => {
		const form = await request.formData();
		const result = await updateArticle({ db: getDb() }, params.id, patchFrom(form));
		if (!result.ok) return failResult(result);
		return { saved: true, slug: result.value.slug };
	},

	// Publish/unpublish also persist the current form so no edits are lost.
	publish: async ({ request, params }) => {
		const form = await request.formData();
		const saved = await updateArticle({ db: getDb() }, params.id, patchFrom(form));
		if (!saved.ok) return failResult(saved);
		const result = await publishArticle({ db: getDb() }, params.id);
		if (!result.ok) return failResult(result);
		return { saved: true, slug: result.value.slug };
	},

	unpublish: async ({ request, params }) => {
		const form = await request.formData();
		const saved = await updateArticle({ db: getDb() }, params.id, patchFrom(form));
		if (!saved.ok) return failResult(saved);
		const result = await unpublishArticle({ db: getDb() }, params.id);
		if (!result.ok) return failResult(result);
		return { saved: true, slug: result.value.slug };
	},

	// Render the CURRENT textarea content (not the saved one) for the preview pane.
	preview: async ({ request }) => {
		const form = await request.formData();
		const bodyMd = formStr(form, 'bodyMd');
		const html = await renderArticleHtml({ db: getDb() }, getImgproxyConfig(), bodyMd);
		return { preview: html };
	}
};
