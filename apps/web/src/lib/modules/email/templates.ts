/**
 * Email templates as typed functions: each key has its own data shape and
 * returns subject + html + text (ro copy). Pure — unit-testable offline.
 */

export interface RenderedEmail {
	subject: string;
	html: string;
	text: string;
}

export interface TemplateData {
	'quiz-result': {
		siteName: string;
		quizTitle: string;
		score: number;
		maxScore: number | null;
		bandLabel: string;
		advice: string;
		resultUrl: string;
	};
	'newsletter-confirm': {
		siteName: string;
		confirmUrl: string;
	};
}

export type TemplateKey = keyof TemplateData;

export const EMAIL_TEMPLATE_KEYS = [
	'quiz-result',
	'newsletter-confirm'
] as const satisfies readonly TemplateKey[];

export function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/** Shared shell so both templates render consistently in email clients. */
function htmlShell(siteName: string, bodyHtml: string): string {
	return `<!doctype html>
<html lang="ro">
<body style="margin:0;padding:24px;background:#f6f6f8;font-family:Arial,Helvetica,sans-serif;color:#1a1a2e;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:10px;padding:32px;">
${bodyHtml}
<p style="margin-top:32px;font-size:12px;color:#6b7280;">${escapeHtml(siteName)}</p>
</div>
</body>
</html>`;
}

function renderQuizResult(data: TemplateData['quiz-result']): RenderedEmail {
	const scoreLine = data.maxScore === null ? `${data.score}` : `${data.score} din ${data.maxScore}`;
	const subject = `Rezultatul tău: ${data.quizTitle}`;
	const html = htmlShell(
		data.siteName,
		`<h1 style="font-size:20px;margin:0 0 16px;">Rezultatul tău la „${escapeHtml(data.quizTitle)}”</h1>
<p style="margin:0 0 8px;">Scor: <strong>${escapeHtml(scoreLine)}</strong></p>
<p style="margin:0 0 16px;">Încadrare: <strong>${escapeHtml(data.bandLabel)}</strong></p>
<p style="margin:0 0 24px;">${escapeHtml(data.advice)}</p>
<p><a href="${escapeHtml(data.resultUrl)}" style="display:inline-block;background:#4c4b9e;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;">Vezi rezultatul complet</a></p>`
	);
	const text = [
		`Rezultatul tău la „${data.quizTitle}”`,
		'',
		`Scor: ${scoreLine}`,
		`Încadrare: ${data.bandLabel}`,
		'',
		data.advice,
		'',
		`Vezi rezultatul complet: ${data.resultUrl}`,
		'',
		data.siteName
	].join('\n');
	return { subject, html, text };
}

function renderNewsletterConfirm(data: TemplateData['newsletter-confirm']): RenderedEmail {
	const subject = `Confirmă abonarea la ${data.siteName}`;
	const html = htmlShell(
		data.siteName,
		`<h1 style="font-size:20px;margin:0 0 16px;">Mai e un pas</h1>
<p style="margin:0 0 24px;">Apasă butonul de mai jos pentru a confirma abonarea la newsletterul ${escapeHtml(data.siteName)}. Dacă nu ai cerut tu această abonare, ignoră acest email.</p>
<p><a href="${escapeHtml(data.confirmUrl)}" style="display:inline-block;background:#4c4b9e;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;">Confirmă abonarea</a></p>`
	);
	const text = [
		'Mai e un pas',
		'',
		`Confirmă abonarea la newsletterul ${data.siteName} deschizând linkul:`,
		data.confirmUrl,
		'',
		'Dacă nu ai cerut tu această abonare, ignoră acest email.',
		'',
		data.siteName
	].join('\n');
	return { subject, html, text };
}

export function renderEmailTemplate<K extends TemplateKey>(
	template: K,
	data: TemplateData[K]
): RenderedEmail {
	switch (template) {
		case 'quiz-result':
			return renderQuizResult(data as TemplateData['quiz-result']);
		case 'newsletter-confirm':
			return renderNewsletterConfirm(data as TemplateData['newsletter-confirm']);
		default:
			throw new Error(`Unknown email template "${template}"`);
	}
}
