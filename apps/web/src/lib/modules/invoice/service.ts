import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import type { DbTx } from '../../server/event-ledger/core.ts';
import type { Result } from '../../util/result.ts';
import { isSettingsPlaceholder, loadSettings } from '$lib/modules/settings/server';
import type { SettingKey, SiteSettings } from '../settings/registry.ts';
import { orderEvents, orderItems, orders, type OrderRow } from '../shop/schema.ts';
import { invoiceLines, invoices, invoiceSeries, type InvoiceRow } from './schema.ts';
import { computeLineAmounts, sumAmounts } from './vat.ts';

/**
 * Invoice issuance: the only writer of the fiscal record. Everything here runs
 * inside the caller's transaction (`DbTx`) so an invoice commits atomically
 * with whatever caused it — the webhook's ledger claim, or the admin retry.
 * The rules it implements (append-only, gapless numbering, snapshot-not-
 * reference, storno-not-edit) are documented in this module's README.
 */

export interface InvoiceDeps {
	db: Db;
}

export type InvoiceError =
	| 'order-not-found'
	/** Only paid (or refunded, for late issuance) orders get an invoice. */
	| 'order-not-invoiceable'
	/** Issuer settings unset or still the seeded placeholder — detail lists the keys. */
	| 'settings-incomplete'
	/** Refund arrived but there is no original invoice to reverse. */
	| 'no-invoice-to-reverse';

export type InvoiceResult<T> = Result<T, InvoiceError>;

/** `created: false` = the document already existed (idempotent re-request). */
export interface IssuedDocument {
	invoice: InvoiceRow;
	created: boolean;
}

/** What issuance snapshots per sold line (order_items already store this). */
export interface InvoiceItemInput {
	name: string;
	qty: number;
	priceCents: number;
}

/** Issuer settings that must be genuinely filled in before issuing. */
export const REQUIRED_ISSUER_SETTINGS: readonly SettingKey[] = [
	'company.legalName',
	'company.cui',
	'company.regCom',
	'company.address',
	'invoice.seriesPrefix'
];

/** Placeholder values count as unset — an invoice must never carry them. */
function settingText(settings: SiteSettings, key: SettingKey): string {
	const value = settings[key];
	if (typeof value !== 'string' || isSettingsPlaceholder(value)) return '';
	return value.trim();
}

export function missingIssuerSettings(settings: SiteSettings): SettingKey[] {
	return REQUIRED_ISSUER_SETTINGS.filter((key) => settingText(settings, key) === '');
}

/**
 * Append a fiscal entry to the order's audit trail, through the caller's
 * transaction. A plain schema-level insert (the shape `appendOrderEvent` in
 * modules/shop writes): importing the shop SERVICE from here would tie the
 * two modules' server barrels into a runtime cycle, and cross-module schema
 * access is the sanctioned coupling for exactly this case.
 */
async function appendFiscalOrderEvent(
	tx: DbTx,
	entry: { orderId: string; kind: string; actor: string; note: string }
): Promise<void> {
	await tx.insert(orderEvents).values({ id: crypto.randomUUID(), ...entry });
}

/** `BSL`, 42 → `BSL-0042` (numbers past 9999 simply stop padding). */
export function composeDisplayNumber(series: string, number: number): string {
	return `${series}-${String(number).padStart(4, '0')}`;
}

/**
 * Allocate the next number in a series — the gapless, race-free core. The
 * UPDATE takes the series row lock, so concurrent issuances serialize here;
 * because allocation and the invoice INSERT share one transaction, a rollback
 * returns the number to the pool instead of leaving a gap. The row is created
 * on first use with `initialNext` (from the `invoice.nextNumber` setting);
 * after that the row is the sole authority.
 */
export async function allocateInvoiceNumber(
	tx: DbTx,
	series: string,
	initialNext: number
): Promise<number> {
	await tx.insert(invoiceSeries).values({ series, nextNumber: initialNext }).onConflictDoNothing();
	const [row] = await tx
		.update(invoiceSeries)
		.set({ nextNumber: sql`${invoiceSeries.nextNumber} + 1` })
		.where(eq(invoiceSeries.series, series))
		.returning({ nextNumber: invoiceSeries.nextNumber });
	return row.nextNumber - 1;
}

/**
 * The shipping line's printed description: generic "Transport" plus the
 * delivery option the customer chose (a settings value snapshotted onto the
 * order at checkout — never a literal from code).
 */
export function shippingLineDescription(order: Pick<OrderRow, 'shippingName'>): string {
	return order.shippingName ? `Transport — ${order.shippingName}` : 'Transport';
}

/** The order's shipping snapshot flattened to one printable address string. */
function buyerAddressFromOrder(order: OrderRow): string {
	const a = order.shippingAddress;
	if (!a) return '';
	return [
		a.line1,
		a.line2,
		[a.postalCode, a.city].filter(Boolean).join(' '),
		[a.state, a.country].filter(Boolean).join(', ')
	]
		.filter((part): part is string => !!part && part.length > 0)
		.join('\n');
}

/**
 * Issue the invoice for a paid order inside the caller's transaction.
 * Idempotent: an existing invoice is returned with `created: false` (callers
 * serialize per order — the webhook holds the freshly inserted order row, the
 * admin retry locks it FOR UPDATE — and the partial unique index on order_id
 * backstops both). A `settings-incomplete` failure writes nothing.
 */
export async function issueInvoiceForOrderInTx(
	tx: DbTx,
	order: OrderRow,
	items: InvoiceItemInput[],
	settings: SiteSettings,
	actor: string
): Promise<InvoiceResult<IssuedDocument>> {
	// A refunded order is still invoiceable: the invoice may be issued late
	// (after a failure) and immediately storno'd.
	if (order.status !== 'paid' && order.status !== 'refunded') {
		return { ok: false, error: 'order-not-invoiceable', detail: order.status };
	}

	const [existing] = await tx
		.select()
		.from(invoices)
		.where(and(eq(invoices.orderId, order.id), eq(invoices.kind, 'invoice')));
	if (existing) return { ok: true, value: { invoice: existing, created: false } };

	const missing = missingIssuerSettings(settings);
	if (missing.length > 0) {
		return { ok: false, error: 'settings-incomplete', detail: missing.join(', ') };
	}

	const vatRegistered = settings['company.vatRegistered'];
	const vatRateBp = vatRegistered ? settings['invoice.vatRateBp'] : 0;
	// Shipping is its own VAT-bearing line (same rate as the goods — transport
	// follows the main supply), so the invoice gross equals EXACTLY what Stripe
	// charged: goods + shipping. Free shipping (0) adds no line.
	const invoiceItems: InvoiceItemInput[] =
		order.shippingCents > 0
			? [
					...items,
					{ name: shippingLineDescription(order), qty: 1, priceCents: order.shippingCents }
				]
			: [...items];
	const lineAmounts = invoiceItems.map((item) =>
		computeLineAmounts({ qty: item.qty, unitPriceCents: item.priceCents, vatRateBp })
	);
	const totals = sumAmounts(lineAmounts);

	const series = settingText(settings, 'invoice.seriesPrefix');
	const number = await allocateInvoiceNumber(tx, series, settings['invoice.nextNumber']);

	const mentions = [
		vatRegistered ? '' : settingText(settings, 'invoice.vatUnregisteredMention'),
		settingText(settings, 'invoice.paymentTermsNote')
	]
		.filter(Boolean)
		.join('\n');

	const issuedAt = new Date();
	const [invoice] = await tx
		.insert(invoices)
		.values({
			id: crypto.randomUUID(),
			kind: 'invoice',
			series,
			number,
			displayNumber: composeDisplayNumber(series, number),
			orderId: order.id,
			issuedAt,
			// The order is paid before issuance, so the invoice is due at issue.
			dueAt: issuedAt,
			currency: order.currency,
			issuerName: settingText(settings, 'company.legalName'),
			issuerCui: settingText(settings, 'company.cui'),
			issuerVatRegistered: vatRegistered,
			issuerRegCom: settingText(settings, 'company.regCom'),
			issuerAddress: settingText(settings, 'company.address'),
			issuerPlace: settingText(settings, 'invoice.issuerPlace'),
			issuerEmail: settingText(settings, 'company.contactEmail'),
			issuerPhone: settingText(settings, 'company.contactPhone'),
			issuerIban: settingText(settings, 'company.iban'),
			issuerBank: settingText(settings, 'company.bank'),
			buyerName: order.billingCompany?.name ?? order.shippingAddress?.name ?? order.email ?? '',
			buyerEmail: order.email,
			buyerAddress: buyerAddressFromOrder(order),
			buyerCompanyName: order.billingCompany?.name ?? null,
			buyerCompanyCui: order.billingCompany?.cui ?? null,
			buyerCompanyRegCom: order.billingCompany?.regCom ?? null,
			netTotalCents: totals.netCents,
			vatTotalCents: totals.vatCents,
			grossTotalCents: totals.grossCents,
			mentions
		})
		.returning();

	if (invoiceItems.length > 0) {
		await tx.insert(invoiceLines).values(
			invoiceItems.map((item, i) => ({
				id: crypto.randomUUID(),
				invoiceId: invoice.id,
				position: i + 1,
				description: item.name,
				qty: item.qty,
				unitPriceCents: item.priceCents,
				vatRateBp,
				...lineAmounts[i]
			}))
		);
	}

	await appendFiscalOrderEvent(tx, {
		orderId: order.id,
		kind: 'invoice-issued',
		actor,
		note: invoice.displayNumber
	});

	return { ok: true, value: { invoice, created: true } };
}

/**
 * Issue the storno (reversal) for a refunded order's invoice. The original is
 * never touched: the storno is a NEW document with its own number in the same
 * series, whose lines negate the original's STORED amounts (no recomputation
 * — the reversal is exact by construction). Idempotent per original invoice.
 */
export async function issueStornoForOrderInTx(
	tx: DbTx,
	order: OrderRow,
	actor: string
): Promise<InvoiceResult<IssuedDocument>> {
	const [original] = await tx
		.select()
		.from(invoices)
		.where(and(eq(invoices.orderId, order.id), eq(invoices.kind, 'invoice')));
	if (!original) return { ok: false, error: 'no-invoice-to-reverse' };

	const [existing] = await tx
		.select()
		.from(invoices)
		.where(eq(invoices.stornoOfInvoiceId, original.id));
	if (existing) return { ok: true, value: { invoice: existing, created: false } };

	// The series row must exist (the original was numbered through it); the
	// initial value only applies to the impossible fresh-series case.
	const number = await allocateInvoiceNumber(tx, original.series, original.number + 1);
	const issuedAt = new Date();
	const [storno] = await tx
		.insert(invoices)
		.values({
			...original,
			id: crypto.randomUUID(),
			kind: 'storno',
			number,
			displayNumber: composeDisplayNumber(original.series, number),
			stornoOfInvoiceId: original.id,
			issuedAt,
			dueAt: issuedAt,
			netTotalCents: -original.netTotalCents,
			vatTotalCents: -original.vatTotalCents,
			grossTotalCents: -original.grossTotalCents
		})
		.returning();

	const originalLines = await tx
		.select()
		.from(invoiceLines)
		.where(eq(invoiceLines.invoiceId, original.id))
		.orderBy(asc(invoiceLines.position));
	if (originalLines.length > 0) {
		await tx.insert(invoiceLines).values(
			originalLines.map((line) => ({
				...line,
				id: crypto.randomUUID(),
				invoiceId: storno.id,
				qty: -line.qty,
				netCents: -line.netCents,
				vatCents: -line.vatCents,
				grossCents: -line.grossCents
			}))
		);
	}

	await appendFiscalOrderEvent(tx, {
		orderId: order.id,
		kind: 'storno-issued',
		actor,
		note: `${storno.displayNumber} → ${original.displayNumber}`
	});

	return { ok: true, value: { invoice: storno, created: true } };
}

export interface EnsuredDocuments {
	invoice: InvoiceRow;
	storno: InvoiceRow | null;
}

/**
 * The admin one-click retry (and any out-of-webhook issuance): lock the order,
 * issue whatever fiscal documents it is still missing — the invoice, plus the
 * storno when the order was refunded. A failure is recorded on the order's
 * event trail (kind `invoice-failed`) and reported to the caller; it never
 * throws away partial progress.
 */
export async function ensureInvoicesForOrder(
	deps: InvoiceDeps,
	orderId: string,
	actor: string
): Promise<InvoiceResult<EnsuredDocuments>> {
	const settings = await loadSettings(deps);
	return deps.db.transaction(async (tx): Promise<InvoiceResult<EnsuredDocuments>> => {
		// Serializes with concurrent retries and webhook redeliveries.
		const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
		if (!order) return { ok: false, error: 'order-not-found' };
		const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));

		const issued = await issueInvoiceForOrderInTx(tx, order, items, settings, actor);
		if (!issued.ok) {
			await appendFiscalOrderEvent(tx, {
				orderId,
				kind: 'invoice-failed',
				actor,
				note: issued.detail ? `${issued.error}: ${issued.detail}` : issued.error
			});
			return issued;
		}

		let storno: InvoiceRow | null = null;
		if (order.status === 'refunded') {
			const reversed = await issueStornoForOrderInTx(tx, order, actor);
			if (!reversed.ok) return reversed;
			storno = reversed.value.invoice;
		}
		return { ok: true, value: { invoice: issued.value.invoice, storno } };
	});
}

/** All fiscal documents of an order (invoice first), for the admin detail. */
export function listInvoicesForOrder(deps: InvoiceDeps, orderId: string): Promise<InvoiceRow[]> {
	return deps.db
		.select()
		.from(invoices)
		.where(eq(invoices.orderId, orderId))
		.orderBy(asc(invoices.issuedAt), asc(invoices.number));
}

/** Line snapshots of one invoice, in print order. */
export function listInvoiceLines(deps: InvoiceDeps, invoiceId: string) {
	return deps.db
		.select()
		.from(invoiceLines)
		.where(eq(invoiceLines.invoiceId, invoiceId))
		.orderBy(asc(invoiceLines.position));
}
