import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import type { DbTx } from '../../server/event-ledger/core.ts';
import { displayCui, isValidCui } from '../../util/cui.ts';
import type { Result } from '../../util/result.ts';
import { parseVatRateSchedule, standardVatRateAt } from '../../util/vat-rates.ts';
import {
	isSettingsPlaceholder,
	loadSettings,
	settingsConsistencyProblems
} from '$lib/modules/settings/server';
import type { SettingKey, SiteSettings } from '../settings/registry.ts';
import { orderEvents, orderItems, orders, type OrderRow } from '../shop/schema.ts';
import { invoiceDateIso } from './model.ts';
import { invoiceLines, invoices, invoiceSeries, type InvoiceRow } from './schema.ts';
import {
	computeLineAmounts,
	partialStornoLineAmounts,
	splitAmountByGross,
	sumAmounts,
	type VatAmounts
} from './vat.ts';

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
	| 'no-invoice-to-reverse'
	/** Nothing left to reverse: the refunded amount is already fully storno'd. */
	| 'nothing-to-storno'
	/** The requested storno would reverse more than the original invoice. */
	| 'storno-exceeds-original';

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
	/** The product's VAT rate (bp) at checkout; null/absent = the standard rate on the order date. */
	vatRateBp?: number | null;
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

/**
 * A reason issuance must refuse: a required key that is unset/placeholder
 * (the bare key), or a key whose value cannot go on an invoice, written as
 * `key (reason)` — the CUI failing its checksum, the RO prefix contradicting
 * `company.vatRegistered` (the same cross-key rule launch:check applies),
 * an unparseable standard-rate schedule. Joined into the `settings-incomplete`
 * detail, so the order's trail names exactly what to fix.
 */
export type IssuerSettingsProblem = SettingKey | `${SettingKey} (${string})`;

export function missingIssuerSettings(settings: SiteSettings): IssuerSettingsProblem[] {
	const problems: IssuerSettingsProblem[] = REQUIRED_ISSUER_SETTINGS.filter(
		(key) => settingText(settings, key) === ''
	);
	const cui = settingText(settings, 'company.cui');
	if (cui && !isValidCui(cui)) problems.push('company.cui (invalid checksum)');
	for (const problem of settingsConsistencyProblems(settings)) {
		problems.push(`${problem.key} (${problem.code})`);
	}
	// The schedule is only consulted for a VAT-registered issuer; an
	// unregistered one invoices at 0 % whatever it says.
	if (
		settings['company.vatRegistered'] &&
		!parseVatRateSchedule(settings['invoice.vatStandardRates'])
	) {
		problems.push('invoice.vatStandardRates (invalid schedule)');
	}
	return problems;
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

/** 2100 → `21%`, 1950 → `19,5%` — the label of a storno line's rate. */
function bpToPercentLabel(rateBp: number): string {
	const whole = Math.trunc(rateBp / 100);
	const frac = rateBp % 100;
	return frac === 0 ? `${whole}%` : `${whole},${String(frac).padStart(2, '0').replace(/0$/, '')}%`;
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
	// The standard rate in force on the ORDER date (chargeability), never
	// "today": a retry after a rate change invoices the order at its own rate.
	// `missingIssuerSettings` already refused an unparseable schedule.
	const standardRateBp = vatRegistered
		? standardVatRateAt(
				parseVatRateSchedule(settings['invoice.vatStandardRates'])!,
				invoiceDateIso(order.createdAt)
			)
		: 0;
	// Shipping is its own VAT-bearing line at the standard rate (transport
	// follows the main supply), so the invoice gross equals EXACTLY what
	// Stripe charged: goods + shipping. Free shipping (0) adds no line.
	const invoiceItems: InvoiceItemInput[] =
		order.shippingCents > 0
			? [
					...items,
					{ name: shippingLineDescription(order), qty: 1, priceCents: order.shippingCents }
				]
			: [...items];
	// Per line: the product's snapshotted rate, else the standard one; an
	// unregistered issuer is 0 % throughout.
	const lineRates = invoiceItems.map((item) =>
		vatRegistered ? (item.vatRateBp ?? standardRateBp) : 0
	);
	const lineAmounts = invoiceItems.map((item, i) =>
		computeLineAmounts({ qty: item.qty, unitPriceCents: item.priceCents, vatRateBp: lineRates[i] })
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
			// Display form: uppercase, RO prefix exactly when registered.
			issuerCui: displayCui(settingText(settings, 'company.cui'), vatRegistered),
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
				vatRateBp: lineRates[i],
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
 * The order's original invoice, row-locked for the rest of the caller's
 * transaction. `SELECT … FOR UPDATE` only locks — it fires no trigger, so the
 * append-only rule is untouched — and it is what serializes concurrent
 * stornos of one invoice: the sum check below reads a stable total.
 */
async function lockOriginalInvoice(tx: DbTx, orderId: string): Promise<InvoiceRow | undefined> {
	const [original] = await tx
		.select()
		.from(invoices)
		.where(and(eq(invoices.orderId, orderId), eq(invoices.kind, 'invoice')))
		.for('update');
	return original;
}

/** What the stornos of `originalId` already reverse, as a POSITIVE amount in bani. */
export async function reversedCentsFor(executor: Db | DbTx, originalId: string): Promise<number> {
	const [row] = await executor
		.select({ total: sql<number>`coalesce(sum(-${invoices.grossTotalCents}), 0)::int` })
		.from(invoices)
		.where(eq(invoices.stornoOfInvoiceId, originalId));
	return Number(row?.total ?? 0);
}

type StornoLineInput = Omit<typeof invoiceLines.$inferInsert, 'id' | 'invoiceId'>;

/**
 * Issue a storno (reversal) of the order's invoice inside the caller's
 * transaction. The original is never touched: the storno is a NEW document
 * with its own number in the same series, referencing the original.
 *
 * Without `grossCents` it reverses whatever is still unreversed — the whole
 * invoice when nothing was storno'd before (lines negate the original's
 * STORED amounts: no recomputation, exact by construction), or the remainder
 * after earlier partial stornos. With `grossCents` it reverses exactly that
 * amount (a partial refund). Either way a storno is a single negative line
 * at the original rate when it is not the full negation, and the stornos of
 * one invoice can never exceed it — checked here under the original's row
 * lock and, as the backstop, by the `invoices_storno_bounded` trigger.
 *
 * Idempotent for the "reverse the rest" form: once fully reversed, the latest
 * storno is returned with `created: false`.
 */
export async function issueStornoForOrderInTx(
	tx: DbTx,
	order: OrderRow,
	actor: string,
	options: { grossCents?: number } = {}
): Promise<InvoiceResult<IssuedDocument>> {
	const original = await lockOriginalInvoice(tx, order.id);
	if (!original) return { ok: false, error: 'no-invoice-to-reverse' };

	const reversed = await reversedCentsFor(tx, original.id);
	const remaining = original.grossTotalCents - reversed;
	if (options.grossCents === undefined && remaining <= 0) {
		const [existing] = await tx
			.select()
			.from(invoices)
			.where(eq(invoices.stornoOfInvoiceId, original.id))
			.orderBy(desc(invoices.number))
			.limit(1);
		if (existing) return { ok: true, value: { invoice: existing, created: false } };
		return { ok: false, error: 'nothing-to-storno', detail: `${original.displayNumber}: 0` };
	}
	const grossCents = options.grossCents ?? remaining;
	if (!Number.isInteger(grossCents) || grossCents <= 0) {
		return { ok: false, error: 'nothing-to-storno', detail: String(grossCents) };
	}
	if (grossCents > remaining) {
		return {
			ok: false,
			error: 'storno-exceeds-original',
			detail: `${grossCents} > ${remaining} (${original.displayNumber})`
		};
	}

	const originalLines = await tx
		.select()
		.from(invoiceLines)
		.where(eq(invoiceLines.invoiceId, original.id))
		.orderBy(asc(invoiceLines.position));

	const full = reversed === 0 && grossCents === original.grossTotalCents;
	let lines: StornoLineInput[];
	let totals: VatAmounts;
	if (full) {
		lines = originalLines.map((line) => ({
			position: line.position,
			description: line.description,
			qty: -line.qty,
			unitPriceCents: line.unitPriceCents,
			vatRateBp: line.vatRateBp,
			netCents: -line.netCents,
			vatCents: -line.vatCents,
			grossCents: -line.grossCents
		}));
		totals = {
			netCents: -original.netTotalCents,
			vatCents: -original.vatTotalCents,
			grossCents: -original.grossTotalCents
		};
	} else {
		// A refund is money, not lines: reverse it per VAT rate present on the
		// original, each rate taking its share of the amount in proportion to
		// that rate's gross (integer bani, exact sum — `splitAmountByGross`),
		// extracted at its own rate. A single-rate invoice yields one line.
		const rateGroups = new Map<number, number>();
		for (const line of originalLines) {
			rateGroups.set(line.vatRateBp, (rateGroups.get(line.vatRateBp) ?? 0) + line.grossCents);
		}
		const shares = splitAmountByGross(
			grossCents,
			[...rateGroups].map(([rateBp, gross]) => ({ key: rateBp, grossCents: gross }))
		);
		lines = shares.map((share, i) => ({
			position: i + 1,
			description:
				shares.length === 1
					? `Storno parțial — factura ${original.displayNumber}`
					: `Storno parțial — factura ${original.displayNumber} (TVA ${bpToPercentLabel(share.key)})`,
			qty: -1,
			unitPriceCents: share.amountCents,
			vatRateBp: share.key,
			...partialStornoLineAmounts(share.amountCents, share.key)
		}));
		totals = sumAmounts(
			lines.map(({ netCents, vatCents, grossCents: g }) => ({ netCents, vatCents, grossCents: g }))
		);
	}

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
			netTotalCents: totals.netCents,
			vatTotalCents: totals.vatCents,
			grossTotalCents: totals.grossCents
		})
		.returning();

	if (lines.length > 0) {
		await tx
			.insert(invoiceLines)
			.values(lines.map((line) => ({ id: crypto.randomUUID(), invoiceId: storno.id, ...line })));
	}

	await appendFiscalOrderEvent(tx, {
		orderId: order.id,
		kind: 'storno-issued',
		actor,
		note: full
			? `${storno.displayNumber} → ${original.displayNumber}`
			: `${storno.displayNumber} → ${original.displayNumber} (parțial: ${grossCents})`
	});

	return { ok: true, value: { invoice: storno, created: true } };
}

/**
 * The admin "storno parțial" action: reverse exactly what Stripe refunded
 * and no earlier storno has reversed yet (`orders.refunded_cents` minus the
 * stornos already issued). No amount is typed by the operator — the fiscal
 * document follows the money movement Stripe recorded, so the two cannot
 * disagree. Locks the order row (serializes with a racing webhook) and
 * records a failure on the order's trail.
 */
export async function issuePartialStornoForOrder(
	deps: InvoiceDeps,
	orderId: string,
	actor: string
): Promise<InvoiceResult<IssuedDocument>> {
	return deps.db.transaction(async (tx): Promise<InvoiceResult<IssuedDocument>> => {
		const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
		if (!order) return { ok: false, error: 'order-not-found' };
		const original = await lockOriginalInvoice(tx, order.id);
		if (!original) return { ok: false, error: 'no-invoice-to-reverse' };
		const reversed = await reversedCentsFor(tx, original.id);
		const grossCents = order.refundedCents - reversed;
		if (grossCents <= 0) {
			return {
				ok: false,
				error: 'nothing-to-storno',
				detail: `rambursat ${order.refundedCents}, stornat ${reversed}`
			};
		}
		const result = await issueStornoForOrderInTx(tx, order, actor, { grossCents });
		if (!result.ok) {
			await appendFiscalOrderEvent(tx, {
				orderId,
				kind: 'storno-failed',
				actor,
				note: result.detail ? `${result.error}: ${result.detail}` : result.error
			});
		}
		return result;
	});
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

		// A refunded order gets whatever is still unreversed storno'd — the
		// whole invoice, or the remainder after earlier partial stornos.
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
