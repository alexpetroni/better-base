import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.ts';
import type { DbTx } from '../../server/event-ledger/core.ts';
import { ensureInvoiceDocument, loadInvoiceModel, type InvoiceDocumentDeps } from './documents.ts';
import type { EFacturaSubmitter } from './efactura-submitter.ts';
import { invoices, invoiceSubmissions } from './schema.ts';

/**
 * SPV submission queue (FIX-12, audit P1 "SPV submission is mandatory but
 * nothing tracks it"). Romanian B2C/B2B e-Factura must reach ANAF within
 * 5 CALENDAR days of issuance; the queue makes that duty visible (the admin
 * "de trimis la ANAF" filter counts the days left) and drives the cron that
 * renders + submits. The nurture-drain claim pattern: `FOR UPDATE SKIP
 * LOCKED` selects a batch, one UPDATE takes the lease, and two concurrent
 * ticks can never hold the same row. Outcomes:
 * - `submitted` → terminal, with ANAF's index;
 * - a thrown submission → retried with doubling backoff, PARKED (`failed`)
 *   after `EFACTURA_MAX_ATTEMPTS` — a human's problem from then on;
 * - `skipped` (no enrollment — today's default submitter) → not an attempt:
 *   the row stays pending and is looked at again after a deferral, while the
 *   XML is already stored for the manual SPV upload.
 */

/** Legea 296/2023 (Codul fiscal art. 10¹ / OUG 120/2021): 5 calendar days. */
export const EFACTURA_DEADLINE_DAYS = 5;
/** Per-run bound: serverless invocations must finish inside their time limit. */
export const EFACTURA_SUBMIT_BATCH = 25;
/** Failed attempts before the row is parked for a human. */
export const EFACTURA_MAX_ATTEMPTS = 5;
/** A lease older than this belongs to a tick that died mid-submit. */
export const EFACTURA_STALE_CLAIM_MINUTES = 15;
/** First retry delay after a failure; doubles per consecutive failure. */
export const EFACTURA_RETRY_BASE_MS = 15 * 60_000;
/** Backoff ceiling: within the statutory window a retry is still daily-ish. */
export const EFACTURA_RETRY_MAX_MS = 6 * 60 * 60_000;
/** How long a `skipped` (unenrolled) row waits before it is looked at again. */
export const EFACTURA_SKIPPED_RETRY_MS = 60 * 60_000;

/** Delay before the next try after `attempts` consecutive failures. Pure. */
export function submissionRetryDelayMs(attempts: number): number {
	const exponent = Math.max(0, attempts - 1);
	return Math.min(EFACTURA_RETRY_BASE_MS * 2 ** exponent, EFACTURA_RETRY_MAX_MS);
}

/**
 * Queue a freshly issued document. Called INSIDE the issuing transaction —
 * the invoice and its submission row commit or roll back together.
 */
export async function recordPendingSubmissionInTx(tx: DbTx, invoiceId: string): Promise<void> {
	await tx.insert(invoiceSubmissions).values({ id: crypto.randomUUID(), invoiceId });
}

export interface EFacturaDrainDeps extends InvoiceDocumentDeps {
	db: Db;
	efactura: EFacturaSubmitter;
}

export interface EFacturaDrainResult {
	claimed: number;
	submitted: number;
	skipped: number;
	retried: number;
	parked: number;
}

/**
 * One cron tick: claim due rows, render/store the XML, submit, record the
 * outcome. Bounded per invocation; a backlog drains over consecutive ticks,
 * oldest document first (its deadline is the nearest).
 */
export async function submitPendingEFactura(
	deps: EFacturaDrainDeps,
	opts: { now?: Date; batchSize?: number } = {}
): Promise<EFacturaDrainResult> {
	const now = opts.now ?? new Date();
	const batchSize = opts.batchSize ?? EFACTURA_SUBMIT_BATCH;
	const staleCutoff = new Date(now.getTime() - EFACTURA_STALE_CLAIM_MINUTES * 60_000);
	const result: EFacturaDrainResult = {
		claimed: 0,
		submitted: 0,
		skipped: 0,
		retried: 0,
		parked: 0
	};

	const claimed = await deps.db.transaction(async (tx) => {
		const due = await tx
			.select({ id: invoiceSubmissions.id })
			.from(invoiceSubmissions)
			.where(
				and(
					eq(invoiceSubmissions.status, 'pending'),
					or(isNull(invoiceSubmissions.claimedAt), lte(invoiceSubmissions.claimedAt, staleCutoff)),
					or(isNull(invoiceSubmissions.nextAttemptAt), lte(invoiceSubmissions.nextAttemptAt, now))
				)
			)
			.orderBy(asc(invoiceSubmissions.createdAt))
			.limit(batchSize)
			.for('update', { skipLocked: true });
		if (due.length === 0) return [];
		return tx
			.update(invoiceSubmissions)
			.set({ claimedAt: now, updatedAt: now })
			.where(
				inArray(
					invoiceSubmissions.id,
					due.map((row) => row.id)
				)
			)
			.returning();
	});
	result.claimed = claimed.length;

	for (const row of claimed) {
		try {
			const model = await loadInvoiceModel(deps, row.invoiceId);
			if (!model) throw new Error(`invoice ${row.invoiceId} not found`);
			const xml = await ensureInvoiceDocument(deps, model, 'xml');
			const outcome = await deps.efactura.submit({
				invoiceId: model.invoice.id,
				displayNumber: model.invoice.displayNumber,
				xml: new TextDecoder().decode(xml)
			});
			if (outcome.status === 'submitted') {
				result.submitted += 1;
				await deps.db
					.update(invoiceSubmissions)
					.set({
						status: 'submitted',
						submittedAt: now,
						anafIndex: outcome.ref,
						error: null,
						claimedAt: null,
						nextAttemptAt: null,
						updatedAt: now
					})
					.where(eq(invoiceSubmissions.id, row.id));
			} else {
				result.skipped += 1;
				await deps.db
					.update(invoiceSubmissions)
					.set({
						claimedAt: null,
						nextAttemptAt: new Date(now.getTime() + EFACTURA_SKIPPED_RETRY_MS),
						updatedAt: now
					})
					.where(eq(invoiceSubmissions.id, row.id));
			}
		} catch (err) {
			const attempts = row.attempts + 1;
			const parked = attempts >= EFACTURA_MAX_ATTEMPTS;
			if (parked) result.parked += 1;
			else result.retried += 1;
			await deps.db
				.update(invoiceSubmissions)
				.set({
					status: parked ? 'failed' : 'pending',
					attempts,
					error: err instanceof Error ? err.message : String(err),
					claimedAt: null,
					nextAttemptAt: parked ? null : new Date(now.getTime() + submissionRetryDelayMs(attempts)),
					updatedAt: now
				})
				.where(eq(invoiceSubmissions.id, row.id));
		}
	}
	return result;
}

/** A document parked after EFACTURA_MAX_ATTEMPTS, as the order page lists it. */
export interface ParkedSubmission {
	invoiceId: string;
	attempts: number;
	error: string | null;
}

/** The order's parked (`failed`) submissions, oldest document first. */
export async function listParkedSubmissionsForOrder(
	deps: { db: Db },
	orderId: string
): Promise<ParkedSubmission[]> {
	return deps.db
		.select({
			invoiceId: invoiceSubmissions.invoiceId,
			attempts: invoiceSubmissions.attempts,
			error: invoiceSubmissions.error
		})
		.from(invoiceSubmissions)
		.innerJoin(invoices, eq(invoices.id, invoiceSubmissions.invoiceId))
		.where(and(eq(invoices.orderId, orderId), eq(invoiceSubmissions.status, 'failed')))
		.orderBy(asc(invoices.issuedAt), asc(invoices.number));
}

/** The re-queue write: back to `pending`, due now, attempts and error reset. */
const REQUEUE_SET = {
	status: 'pending' as const,
	attempts: 0,
	nextAttemptAt: null,
	error: null,
	claimedAt: null,
	updatedAt: sql`now()`
};

/**
 * Operator re-queue of ONE parked document (FIX-17; the order page's
 * `requeue` action and `pnpm efactura:requeue <invoiceId>`): the next cron
 * tick claims it again. Only a `failed` row changes — pending/submitted rows
 * and unknown ids return false. `orderId` scopes the write to that order's
 * documents (the page never re-queues another order's invoice).
 */
export async function requeueParkedSubmission(
	deps: { db: Db },
	invoiceId: string,
	opts: { orderId?: string } = {}
): Promise<boolean> {
	const scope = opts.orderId
		? inArray(
				invoiceSubmissions.invoiceId,
				deps.db.select({ id: invoices.id }).from(invoices).where(eq(invoices.orderId, opts.orderId))
			)
		: undefined;
	const changed = await deps.db
		.update(invoiceSubmissions)
		.set(REQUEUE_SET)
		.where(
			and(
				eq(invoiceSubmissions.invoiceId, invoiceId),
				eq(invoiceSubmissions.status, 'failed'),
				scope
			)
		)
		.returning({ id: invoiceSubmissions.id });
	return changed.length === 1;
}

/** `pnpm efactura:requeue --all`: every parked document; returns how many. */
export async function requeueAllParkedSubmissions(deps: { db: Db }): Promise<number> {
	const changed = await deps.db
		.update(invoiceSubmissions)
		.set(REQUEUE_SET)
		.where(eq(invoiceSubmissions.status, 'failed'))
		.returning({ id: invoiceSubmissions.id });
	return changed.length;
}

/**
 * Calendar days left until the statutory deadline of the order's most
 * urgent unsubmitted document, as an SQL expression over `orders.id`; NULL
 * when every document of the order is submitted (or none is issued). Dates
 * are Romanian legal dates (Europe/Bucharest), like the documents.
 */
export function efacturaDaysLeftSql(orderIdColumn: AnyPgColumn) {
	return sql<
		number | null
	>`(select min(((i.issued_at at time zone 'Europe/Bucharest')::date + ${sql.raw(String(EFACTURA_DEADLINE_DAYS))}) - (now() at time zone 'Europe/Bucharest')::date)
		from invoices i join invoice_submissions s on s.invoice_id = i.id
		where i.order_id = ${orderIdColumn} and s.status <> 'submitted')`;
}
