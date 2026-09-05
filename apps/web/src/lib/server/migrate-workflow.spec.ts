import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * The CI pipeline is the only automated path to the production schema and
 * the production deploy (FIX-16, audit P0 #5). A broken trigger, a missing
 * secret guard, a stray seed step or a deploy that no longer waits for the
 * migration is not detectable from any local run — so the YAML itself and
 * the site matrix it reads are under test.
 */
const root = path.resolve(import.meta.dirname, '../../../../..');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

interface Step {
	name?: string;
	uses?: string;
	run?: string;
	if?: string;
	'working-directory'?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
}
interface Job {
	needs?: string | string[];
	if?: string;
	environment?: string | { name: string };
	'continue-on-error'?: boolean;
	concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
	strategy?: { matrix?: Record<string, unknown>; 'fail-fast'?: boolean };
	env?: Record<string, string>;
	outputs?: Record<string, string>;
	services?: Record<string, { image: string }>;
	steps: Step[];
}
interface Workflow {
	on: Record<string, unknown>;
	jobs: Record<string, Job>;
}

const ci = parse(read('.github/workflows/ci.yml')) as Workflow;
const backup = parse(read('.github/workflows/backup.yml')) as Workflow;
const sites = JSON.parse(read('deploy/sites.json')) as {
	sites: Array<{
		id: string;
		directDatabaseUrlSecret: string;
		vercelProjectIdSecret: string;
		mediaBucket: string;
		fiscalBucket: string;
	}>;
};

const needsOf = (job: Job): string[] =>
	Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
const runsOf = (job: Job): string => job.steps.map((step) => step.run ?? '').join('\n');

describe('deploy/sites.json', () => {
	it('lists the sleep site with the secret names its jobs read', () => {
		const sleep = sites.sites.find((site) => site.id === 'sleep');
		expect(sleep).toEqual({
			id: 'sleep',
			directDatabaseUrlSecret: 'DIRECT_DATABASE_URL_SLEEP',
			vercelProjectIdSecret: 'VERCEL_PROJECT_ID_SLEEP',
			mediaBucket: 'bettersleep-media',
			fiscalBucket: 'bettersleep-fiscal'
		});
		// Secret names are env-var shaped: a typo here is a failed-closed run.
		for (const site of sites.sites) {
			expect(site.directDatabaseUrlSecret).toMatch(/^[A-Z][A-Z0-9_]+$/);
			expect(site.vercelProjectIdSecret).toMatch(/^[A-Z][A-Z0-9_]+$/);
			expect(site.fiscalBucket).not.toBe(site.mediaBucket);
		}
	});
});

describe('.github/workflows/ci.yml', () => {
	it('replaces migrate.yml', () => {
		expect(existsSync(path.join(root, '.github/workflows/migrate.yml'))).toBe(false);
	});

	it('runs on every PR and push to main, and on manual dispatch', () => {
		expect(ci.on).toHaveProperty('pull_request');
		expect(ci.on).toHaveProperty('workflow_dispatch');
		expect((ci.on.push as { branches: string[] }).branches).toEqual(['main']);
	});

	it('gate: services, fresh-db migrate, drizzle check, unit tests, both builds, vercel preflight', () => {
		const gate = ci.jobs.gate;
		expect(needsOf(gate)).toEqual([]);
		expect(gate.services?.postgres?.image).toMatch(/^postgres:16\.\d+$/);
		expect(gate.env?.CI).toBe('true');
		const runs = runsOf(gate);
		for (const command of [
			'pnpm lint',
			'pnpm check',
			'pnpm db:migrate',
			'pnpm db:check',
			'pnpm test:unit',
			'pnpm build',
			'DEPLOY_TARGET=vercel pnpm build',
			'launch:check --target=vercel'
		]) {
			expect(runs).toContain(command);
		}
		// The order is the point: nothing tests against an unmigrated database.
		expect(runs.indexOf('pnpm db:migrate')).toBeLessThan(runs.indexOf('pnpm test:unit'));
		// MinIO is pinned like every other image.
		expect(runs).toMatch(/minio\/minio:RELEASE\.\d{4}-\d{2}-\d{2}T/);
	});

	it('gate: audits production dependencies at the high level (FIX-18, review 2026-09-05 #5)', () => {
		const runs = runsOf(ci.jobs.gate);
		expect(runs).toContain('pnpm audit --prod --audit-level=high');
		// The local gate script is the same list of commands.
		const root = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
		expect(root.scripts.gate).toContain('pnpm audit --prod --audit-level=high');
		for (const command of ['pnpm lint', 'pnpm check', 'pnpm test:unit']) {
			expect(root.scripts.gate).toContain(command);
		}
	});

	it('gate: its env is dev-shaped, never a production secret', () => {
		const env = ci.jobs.gate.env ?? {};
		expect(JSON.stringify(env)).not.toContain('secrets.');
		expect(env.EMAIL_DRYRUN).toBe('true');
		expect(env.CHAT_PROVIDER).toBe('mock');
		expect(env.COURIER_PROVIDER).toBe('mock');
		expect(env.STRIPE_SECRET_KEY ?? '').toBe('');
	});

	it('e2e: PRs only, non-blocking', () => {
		const e2e = ci.jobs.e2e;
		expect(e2e['continue-on-error']).toBe(true);
		expect(e2e.if).toContain("github.event_name == 'pull_request'");
		expect(runsOf(e2e)).toContain('pnpm test:e2e');
	});

	it('migrate: needs the gate, main only, production environment, one site per matrix entry', () => {
		const migrate = ci.jobs.migrate;
		expect(needsOf(migrate)).toEqual(expect.arrayContaining(['gate', 'sites']));
		expect(migrate.if).toContain("github.ref == 'refs/heads/main'");
		expect(migrate.environment).toBe('production');
		expect(migrate.concurrency?.group).toBeTruthy();
		expect(migrate.concurrency?.['cancel-in-progress']).toBe(false);
		expect(migrate.strategy?.['fail-fast']).toBe(false);
		expect(JSON.stringify(migrate.strategy?.matrix)).toContain(
			'fromJson(needs.sites.outputs.matrix)'
		);
		// The matrix is read from the committed file, not typed into YAML.
		expect(runsOf(ci.jobs.sites)).toContain('deploy/sites.json');
		expect(ci.jobs.sites.outputs?.matrix).toBeTruthy();
		// The secret is resolved per site from the JSON entry.
		expect(migrate.env?.DIRECT_DATABASE_URL).toBe(
			'${{ secrets[matrix.site.directDatabaseUrlSecret] }}'
		);
	});

	it('migrate: fails closed without the secret, installs web only without scripts, migrates then prints status, never seeds', () => {
		const migrate = ci.jobs.migrate;
		const guard = migrate.steps.find((step) => step.run?.includes('-z "$DIRECT_DATABASE_URL"'));
		expect(guard?.run).toContain('exit 1');
		const runs = migrate.steps.map((step) => step.run).filter(Boolean) as string[];
		expect(
			runs.some((run) =>
				run.includes('pnpm install --frozen-lockfile --ignore-scripts --filter web')
			)
		).toBe(true);
		expect(runs).toContain('pnpm db:migrate');
		expect(runs).toContain('pnpm db:status');
		expect(runs.indexOf('pnpm db:status')).toBeGreaterThan(runs.indexOf('pnpm db:migrate'));
		const commands = runs.join('\n');
		expect(commands).not.toMatch(/db:seed/);
		expect(commands).not.toMatch(/content:init/);
		expect(commands).not.toMatch(/user:create/);
	});

	it('deploy: needs migrate, prebuilt production deploy per site with the Vercel secrets', () => {
		const deploy = ci.jobs.deploy;
		expect(needsOf(deploy)).toEqual(expect.arrayContaining(['migrate', 'sites']));
		expect(deploy.if).toContain("github.ref == 'refs/heads/main'");
		expect(deploy.environment).toBe('production');
		const runs = runsOf(deploy);
		expect(runs).toMatch(/vercel(@[\d.]+)? pull --yes --environment=production/);
		expect(runs).toMatch(/vercel(@[\d.]+)? build --prod/);
		expect(runs).toMatch(/vercel(@[\d.]+)? deploy --prebuilt --prod/);
		expect(deploy.env?.VERCEL_TOKEN).toBe('${{ secrets.VERCEL_TOKEN }}');
		expect(deploy.env?.VERCEL_ORG_ID).toBe('${{ secrets.VERCEL_ORG_ID }}');
		expect(deploy.env?.VERCEL_PROJECT_ID).toBe('${{ secrets[matrix.site.vercelProjectIdSecret] }}');
	});

	it('pins every action to a commit SHA', () => {
		for (const workflow of [ci, backup]) {
			for (const job of Object.values(workflow.jobs)) {
				for (const step of job.steps) {
					if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}( #.*)?$/);
				}
			}
		}
	});
});

// Review 2026-09-05 #8: the checklist told the operator to set a secret CI
// never reads (`DIRECT_DATABASE_URL`, unsuffixed) and to run a workflow FIX-16
// deleted (`migrate.yml`) — the fail-closed guard then blocks the first
// production deploy with no explanation. The box is kept true to the files
// it describes.
describe('LAUNCH-CHECKLIST.md matches the shipped pipeline', () => {
	const checklist = read('LAUNCH-CHECKLIST.md');
	const ciYaml = read('.github/workflows/ci.yml');
	const backupYaml = read('.github/workflows/backup.yml');
	const sitesJson = read('deploy/sites.json');

	it('never names the deleted migrate.yml workflow', () => {
		expect(checklist).not.toMatch(/migrate\.yml/);
		expect(checklist).not.toMatch(/Actions → migrate\b/);
	});

	it('never names an unsuffixed DIRECT_DATABASE_URL as a GitHub secret', () => {
		// The env var of that name exists (scripts read it from a checkout);
		// as a GitHub SECRET only the per-site suffixed names exist.
		const secretMentions = checklist.match(/`DIRECT_DATABASE_URL[A-Z0-9_]*`/g) ?? [];
		expect(secretMentions.length).toBeGreaterThan(0);
		for (const mention of secretMentions) {
			expect(mention).not.toBe('`DIRECT_DATABASE_URL`');
		}
	});

	it('every GitHub secret it names is one ci.yml/backup.yml reads or deploy/sites.json declares', () => {
		const named = new Set(
			[...checklist.matchAll(/`((?:DIRECT_DATABASE_URL|VERCEL)_[A-Z0-9_]+)`/g)].map((m) => m[1])
		);
		expect(named.size).toBeGreaterThan(0);
		for (const secret of named) {
			const known =
				ciYaml.includes(`secrets.${secret}`) ||
				backupYaml.includes(`secrets.${secret}`) ||
				sitesJson.includes(`"${secret}"`);
			expect(known, `${secret} is named in LAUNCH-CHECKLIST.md but nothing reads it`).toBe(true);
		}
		// And the per-site names the matrix declares are what the checklist tells the operator to set.
		for (const site of sites.sites) {
			expect(checklist).toContain(site.directDatabaseUrlSecret);
			expect(checklist).toContain(site.vercelProjectIdSecret);
		}
	});
});

describe('.github/workflows/backup.yml', () => {
	it('runs nightly and on dispatch, one site per matrix entry, through scripts/backup.sh', () => {
		const schedule = backup.on.schedule as Array<{ cron: string }>;
		expect(schedule?.[0]?.cron).toMatch(/^\d+ \d+ \* \* \*$/);
		expect(backup.on).toHaveProperty('workflow_dispatch');
		const job = backup.jobs.backup;
		expect(JSON.stringify(job.strategy?.matrix)).toContain('fromJson(needs.sites.outputs.matrix)');
		expect(runsOf(job)).toContain('scripts/backup.sh');
		expect(job.env?.DIRECT_DATABASE_URL).toBe(
			'${{ secrets[matrix.site.directDatabaseUrlSecret] }}'
		);
		expect(job.env?.BACKUP_MEDIA_BUCKET).toBe('${{ matrix.site.mediaBucket }}');
		expect(job.env?.BACKUP_FISCAL_BUCKET).toBe('${{ matrix.site.fiscalBucket }}');
	});
});
