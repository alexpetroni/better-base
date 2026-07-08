import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/db';
import { confirmUpload, getStorage, imgSources, requestUpload } from '$lib/modules/media/server';
import type { RequestHandler } from './$types';

/**
 * JSON endpoint for the two server halves of a direct-to-storage upload:
 *   { op: 'presign', filename, mime, size } → { key, uploadUrl }
 *   { op: 'confirm', key, filename, alt? }  → { media, thumb }
 * The browser PUTs the file to `uploadUrl` between the two calls.
 * /admin/* is staff-gated by hooks.server.ts.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const user = locals.user;
	if (!user) error(401);

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON body');
	}
	const deps = { db: getDb(), storage: getStorage() };

	if (body.op === 'presign') {
		const result = await requestUpload(deps, {
			filename: String(body.filename ?? ''),
			mime: String(body.mime ?? ''),
			size: Number(body.size)
		});
		if (!result.ok) return json({ error: result.error }, { status: 400 });
		return json(result.value);
	}

	if (body.op === 'confirm') {
		const result = await confirmUpload(deps, {
			key: String(body.key ?? ''),
			filename: String(body.filename ?? ''),
			alt: typeof body.alt === 'string' ? body.alt : undefined,
			createdBy: user.id
		});
		if (!result.ok) {
			return json({ error: result.error }, { status: result.error === 'not-found' ? 404 : 400 });
		}
		return json({ media: result.value, thumb: imgSources(result.value, { w: 320 }) });
	}

	error(400, 'Unknown op');
};
