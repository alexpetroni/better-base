import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * The CI migration workflow is the only automated path to the production
 * schema, and a broken trigger, a missing secret guard or a stray seed step
 * is not detectable from any local run — so the YAML itself is under test.
 */
const raw = readFileSync(
	path.resolve(import.meta.dirname, '../../../../../.github/workflows/migrate.yml'),
	'utf8'
);

interface Step {
	name?: string;
	uses?: string;
	run?: string;
	env?: Record<string, string>;
}
const workflow = parse(raw) as {
	on: { workflow_dispatch: unknown; push?: { branches?: string[] } };
	concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
	jobs: Record<string, { env?: Record<string, string>; steps: Step[] }>;
};
const job = workflow.jobs.migrate;

describe('.github/workflows/migrate.yml', () => {
	it('runs on manual dispatch AND on push to the production branch', () => {
		expect(workflow.on).toHaveProperty('workflow_dispatch');
		expect(workflow.on.push?.branches).toEqual(['main']);
	});

	it('takes the database URL from the DIRECT_DATABASE_URL repository secret', () => {
		expect(job.env?.DIRECT_DATABASE_URL).toBe('${{ secrets.DIRECT_DATABASE_URL }}');
	});

	it('fails closed when the secret is absent — first step, before any install', () => {
		const guard = job.steps[0];
		expect(guard.run).toContain('-z "$DIRECT_DATABASE_URL"');
		expect(guard.run).toContain('exit 1');
		expect(guard.uses).toBeUndefined();
	});

	it('applies migrations and prints the applied list', () => {
		const runs = job.steps.map((step) => step.run).filter(Boolean);
		expect(runs).toContain('pnpm db:migrate');
		expect(runs).toContain('pnpm db:status');
		// status runs after migrate, so the log records the post-run state
		expect(runs.indexOf('pnpm db:status')).toBeGreaterThan(runs.indexOf('pnpm db:migrate'));
	});

	it('never seeds — content writes are a human step, not a side effect of CI', () => {
		const commands = job.steps.map((step) => step.run ?? '').join('\n');
		expect(commands).not.toMatch(/db:seed/);
		expect(commands).not.toMatch(/content:init/);
		expect(commands).not.toMatch(/user:create/);
	});

	it('serializes runs so two pushes cannot race DDL', () => {
		expect(workflow.concurrency?.group).toBeTruthy();
		expect(workflow.concurrency?.['cancel-in-progress']).toBe(false);
	});
});
