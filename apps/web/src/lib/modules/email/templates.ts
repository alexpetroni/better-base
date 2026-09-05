import { formatCents } from '../../util/money.ts';

/**
 * Email templates as typed functions: each key has its own data shape and
 * returns subject + html + text (ro copy). Pure — unit-testable offline.
 */

export interface RenderedEmail {
	subject: string;
	html: string;
	text: string;
	/**
	 * Extra message headers. Marketing templates set the RFC 8058 pair
	 * (`List-Unsubscribe`, `List-Unsubscribe-Post`) so mail clients offer a
	 * one-click unsubscribe that POSTs to the same URL as the footer link.
	 */
	headers?: Record<string, string>;
}

/** RFC 8058 one-click headers for a marketing message. */
export function listUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
	return {
		'List-Unsubscribe': `<${unsubscribeUrl}>`,
		'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
	};
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
		/** Set when the fiscal invoice was issued — its PDF rides along. */
		invoiceNumber?: string;
		/** Durable no-account link back to the order (and its invoice). */
		orderUrl?: string;
	};
	/** Admin-triggered (re)delivery of an issued invoice, PDF attached. */
	'invoice-email': {
		siteName: string;
		invoiceNumber: string;
		orderUrl?: string;
	};
	/** Sent once per shipment when the AWB is generated (key derives from it). */
	'shipping-notification': {
		siteName: string;
		orderId: string;
		awb: string;
		trackingUrl: string;
		/** Delivery option chosen at checkout, e.g. `Curier standard`. */
		shippingName?: string;
		/** Durable no-account link back to the order. */
		orderUrl?: string;
	};
	/**
	 * Nurture sequence step (modules/nurture): subject and copy come from the
	 * sequence DATA, so sites differ without new templates. Marketing mail —
	 * the unsubscribe link is required and always rendered.
	 */
	nurture: {
		siteName: string;
		subject: string;
		paragraphs: string[];
		cta?: { label: string; url: string };
		unsubscribeUrl: string;
	};
}

export type TemplateKey = keyof TemplateData;

export const EMAIL_TEMPLATE_KEYS = [
	'quiz-result',
	'newsletter-confirm',
	'order-confirmation',
	'invoice-email',
	'shipping-notification',
	'nurture'
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

function invoiceHtmlBlock(
	data: Pick<TemplateData['order-confirmation'], 'invoiceNumber' | 'orderUrl'>
): string {
	const parts: string[] = [];
	if (data.invoiceNumber) {
		parts.push(
			`<p style="margin:24px 0 0;">Factura <strong>${escapeHtml(data.invoiceNumber)}</strong> este atașată acestui email.</p>`
		);
	}
	if (data.orderUrl) {
		parts.push(
			`<p style="margin:${data.invoiceNumber ? '8px' : '24px'} 0 0;">Poți reveni oricând la comanda ta${data.invoiceNumber ? ' și la factură' : ''}: <a href="${escapeHtml(data.orderUrl)}" style="color:#4c4b9e;">vezi comanda</a>.</p>`
		);
	}
	return parts.join('\n');
}

function invoiceTextBlock(
	data: Pick<TemplateData['order-confirmation'], 'invoiceNumber' | 'orderUrl'>
): string[] {
	const parts: string[] = [];
	if (data.invoiceNumber) {
		parts.push('', `Factura ${data.invoiceNumber} este atașată acestui email.`);
	}
	if (data.orderUrl) {
		parts.push('', `Poți reveni oricând la comanda ta: ${data.orderUrl}`);
	}
	return parts;
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
<p style="margin:24px 0 0;">Te anunțăm când comanda pleacă spre tine.</p>
${invoiceHtmlBlock(data)}`
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
		...invoiceTextBlock(data),
		'',
		data.siteName
	].join('\n');
	return { subject, html, text };
}

function renderInvoiceEmail(data: TemplateData['invoice-email']): RenderedEmail {
	const subject = `Factura ta ${data.invoiceNumber} de la ${data.siteName}`;
	const html = htmlShell(
		data.siteName,
		`<h1 style="font-size:20px;margin:0 0 16px;">Factura ta</h1>
<p style="margin:0 0 8px;">Găsești atașată factura <strong>${escapeHtml(data.invoiceNumber)}</strong> pentru comanda ta la ${escapeHtml(data.siteName)}.</p>
${data.orderUrl ? `<p style="margin:16px 0 0;"><a href="${escapeHtml(data.orderUrl)}" style="color:#4c4b9e;">Vezi comanda și factura online</a></p>` : ''}`
	);
	const text = [
		'Factura ta',
		'',
		`Găsești atașată factura ${data.invoiceNumber} pentru comanda ta la ${data.siteName}.`,
		...(data.orderUrl ? ['', `Vezi comanda și factura online: ${data.orderUrl}`] : []),
		'',
		data.siteName
	].join('\n');
	return { subject, html, text };
}

function renderShippingNotification(data: TemplateData['shipping-notification']): RenderedEmail {
	const subject = `Comanda ta de la ${data.siteName} a fost expediată`;
	const carrierLine = data.shippingName
		? `Coletul a fost predat către ${data.shippingName}.`
		: 'Coletul a fost predat curierului.';
	const html = htmlShell(
		data.siteName,
		`<h1 style="font-size:20px;margin:0 0 16px;">Comanda ta e pe drum!</h1>
<p style="margin:0 0 8px;">${escapeHtml(carrierLine)}</p>
<p style="margin:0 0 16px;">Număr de urmărire (AWB): <strong>${escapeHtml(data.awb)}</strong></p>
<p><a href="${escapeHtml(data.trackingUrl)}" style="display:inline-block;background:#4c4b9e;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;">Urmărește coletul</a></p>
${data.orderUrl ? `<p style="margin:24px 0 0;">Poți reveni oricând la comanda ta: <a href="${escapeHtml(data.orderUrl)}" style="color:#4c4b9e;">vezi comanda</a>.</p>` : ''}`
	);
	const text = [
		'Comanda ta e pe drum!',
		'',
		carrierLine,
		`Număr de urmărire (AWB): ${data.awb}`,
		'',
		`Urmărește coletul: ${data.trackingUrl}`,
		...(data.orderUrl ? ['', `Poți reveni oricând la comanda ta: ${data.orderUrl}`] : []),
		'',
		data.siteName
	].join('\n');
	return { subject, html, text };
}

function renderNurture(data: TemplateData['nurture']): RenderedEmail {
	const paragraphsHtml = data.paragraphs
		.map((p) => `<p style="margin:0 0 16px;">${escapeHtml(p)}</p>`)
		.join('\n');
	const ctaHtml = data.cta
		? `<p style="margin:8px 0 0;"><a href="${escapeHtml(data.cta.url)}" style="display:inline-block;background:#4c4b9e;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;">${escapeHtml(data.cta.label)}</a></p>`
		: '';
	const html = htmlShell(
		data.siteName,
		`<h1 style="font-size:20px;margin:0 0 16px;">${escapeHtml(data.subject)}</h1>
${paragraphsHtml}
${ctaHtml}
<p style="margin:24px 0 0;font-size:12px;color:#6b7280;">Primești acest email pentru că te-ai abonat la ${escapeHtml(data.siteName)}. <a href="${escapeHtml(data.unsubscribeUrl)}" style="color:#6b7280;">Dezabonează-te</a> oricând, cu un clic.</p>`
	);
	const text = [
		data.subject,
		'',
		...data.paragraphs.flatMap((p) => [p, '']),
		...(data.cta ? [`${data.cta.label}: ${data.cta.url}`, ''] : []),
		`Primești acest email pentru că te-ai abonat la ${data.siteName}.`,
		`Dezabonează-te oricând: ${data.unsubscribeUrl}`,
		'',
		data.siteName
	].join('\n');
	return {
		subject: data.subject,
		html,
		text,
		headers: listUnsubscribeHeaders(data.unsubscribeUrl)
	};
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
		case 'invoice-email':
			return renderInvoiceEmail(data as TemplateData['invoice-email']);
		case 'shipping-notification':
			return renderShippingNotification(data as TemplateData['shipping-notification']);
		case 'nurture':
			return renderNurture(data as TemplateData['nurture']);
		default:
			throw new Error(`Unknown email template "${template}"`);
	}
}
