import { formatCents } from '../shop/money.ts';

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
	'order-confirmation': {
		siteName: string;
		orderId: string;
		/** Snapshots as sold; prices are unit prices in integer cents. */
		items: Array<{ name: string; qty: number; priceCents: number }>;
		totalCents: number;
		currency: string;
	};
}

export type TemplateKey = keyof TemplateData;

export const EMAIL_TEMPLATE_KEYS = [
	'quiz-result',
	'newsletter-confirm',
	'order-confirmation'
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

function renderOrderConfirmation(data: TemplateData['order-confirmation']): RenderedEmail {
	const subject = `Comanda ta la ${data.siteName} a fost înregistrată`;
	const rows = data.items
		.map(
			(item) => `<tr>
<td style="padding:4px 8px 4px 0;">${escapeHtml(item.name)}</td>
<td style="padding:4px 8px;text-align:center;">×${item.qty}</td>
<td style="padding:4px 0;text-align:right;">${escapeHtml(formatCents(item.priceCents * item.qty, data.currency))}</td>
</tr>`
		)
		.join('\n');
	const html = htmlShell(
		data.siteName,
		`<h1 style="font-size:20px;margin:0 0 16px;">Îți mulțumim pentru comandă!</h1>
<p style="margin:0 0 16px;">Comanda <strong>${escapeHtml(data.orderId)}</strong> a fost înregistrată și plătită.</p>
<table style="width:100%;border-collapse:collapse;font-size:14px;">
${rows}
<tr>
<td colspan="2" style="padding:8px 8px 0 0;border-top:1px solid #e5e7eb;"><strong>Total</strong></td>
<td style="padding:8px 0 0;border-top:1px solid #e5e7eb;text-align:right;"><strong>${escapeHtml(formatCents(data.totalCents, data.currency))}</strong></td>
</tr>
</table>
<p style="margin:24px 0 0;">Te anunțăm când comanda pleacă spre tine.</p>`
	);
	const text = [
		'Îți mulțumim pentru comandă!',
		'',
		`Comanda ${data.orderId} a fost înregistrată și plătită.`,
		'',
		...data.items.map(
			(item) =>
				`${item.name} ×${item.qty} — ${formatCents(item.priceCents * item.qty, data.currency)}`
		),
		'',
		`Total: ${formatCents(data.totalCents, data.currency)}`,
		'',
		'Te anunțăm când comanda pleacă spre tine.',
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
		case 'order-confirmation':
			return renderOrderConfirmation(data as TemplateData['order-confirmation']);
		default:
			throw new Error(`Unknown email template "${template}"`);
	}
}
