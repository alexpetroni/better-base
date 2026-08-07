import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
	canTransition,
	FULFILLMENT_STATUSES,
	IllegalTransitionError,
	isFulfillmentStatus,
	legalTransitions,
	type FulfillmentStatus
} from './fulfillment.ts';

describe('fulfillment state machine', () => {
	const LEGAL: Array<[FulfillmentStatus, FulfillmentStatus]> = [
		['unfulfilled', 'packed'],
		['unfulfilled', 'cancelled'],
		['packed', 'shipped'],
		['packed', 'unfulfilled'], // unpack correction
		['packed', 'cancelled'],
		['shipped', 'delivered'],
		['shipped', 'returned'],
		['delivered', 'returned']
	];

	it.each(LEGAL)('allows %s → %s', (from, to) => {
		expect(canTransition(from, to)).toBe(true);
		expect(legalTransitions(from)).toContain(to);
	});

	it('rejects everything not in the legal table (skipping states, reversing shipment, leaving terminals)', () => {
		const legal = new Set(LEGAL.map(([from, to]) => `${from}>${to}`));
		for (const from of FULFILLMENT_STATUSES) {
			for (const to of FULFILLMENT_STATUSES) {
				if (from === to || legal.has(`${from}>${to}`)) continue;
				expect(canTransition(from, to), `${from} → ${to} must be illegal`).toBe(false);
			}
		}
		// Self-transitions are not moves either.
		for (const state of FULFILLMENT_STATUSES) {
			expect(canTransition(state, state)).toBe(false);
		}
		// Terminal states offer nothing.
		expect(legalTransitions('returned')).toHaveLength(0);
		expect(legalTransitions('cancelled')).toHaveLength(0);
	});

	it('isFulfillmentStatus narrows only real statuses', () => {
		for (const status of FULFILLMENT_STATUSES) expect(isFulfillmentStatus(status)).toBe(true);
		expect(isFulfillmentStatus('paid')).toBe(false);
		expect(isFulfillmentStatus('')).toBe(false);
		expect(isFulfillmentStatus(null)).toBe(false);
	});

	it('IllegalTransitionError carries the endpoints', () => {
		const err = new IllegalTransitionError('delivered', 'packed');
		expect(err.from).toBe('delivered');
		expect(err.to).toBe('packed');
		expect(err.message).toContain('delivered → packed');
	});
});

describe('fulfillment single-writer rule', () => {
	async function sourceFiles(dir: string): Promise<string[]> {
		const entries = await readdir(dir, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
			else if (/\.(ts|svelte)$/.test(entry.name)) files.push(full);
		}
		return files;
	}

	it('only fulfillment-service.ts (and the backfill migration) write fulfillment_status', async () => {
		// The state machine is worthless if any route or service can poke the
		// column directly — scan every source file for a Drizzle `.set({...})`
		// (or raw SQL UPDATE) touching it and pin the allowed writer.
		const srcRoot = path.resolve(import.meta.dirname, '../..');
		const offenders: string[] = [];
		for (const file of await sourceFiles(srcRoot)) {
			const text = await readFile(file, 'utf8');
			const writes =
				/set\(\s*\{[^}]*fulfillmentStatus/s.test(text) ||
				/UPDATE[^;]+fulfillment_status\s*=/is.test(text);
			if (writes && !file.endsWith(`shop${path.sep}fulfillment-service.ts`)) {
				offenders.push(path.relative(srcRoot, file));
			}
		}
		expect(offenders).toEqual([]);
	});
});
