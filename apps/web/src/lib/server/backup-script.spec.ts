import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * scripts/backup.sh (FIX-16, audit "No backup/restore path") in --dry-run
 * mode prints the exact commands it would run — pg_dump of the unpooled URL
 * to a dated custom-format file, upload, and an rclone sync per bucket to
 * the second provider — with the retention it would apply, without touching
 * anything. The runbook (docs/RESTORE.md) quotes these commands.
 */
const run = promisify(execFile);
const script = path.resolve(import.meta.dirname, '../../../../../scripts/backup.sh');

const env = {
	PATH: process.env.PATH,
	BACKUP_SITE: 'sleep',
	DIRECT_DATABASE_URL:
		'postgres://app:s3cr3t@ep-x.eu-central-1.aws.neon.tech/better_sleep?sslmode=require',
	BACKUP_MEDIA_BUCKET: 'bettersleep-media',
	BACKUP_FISCAL_BUCKET: 'bettersleep-fiscal',
	BACKUP_SRC_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
	BACKUP_SRC_ACCESS_KEY: 'src-key',
	BACKUP_SRC_SECRET_KEY: 'src-secret',
	BACKUP_DST_ENDPOINT: 'https://s3.eu-central-003.backblazeb2.com',
	BACKUP_DST_ACCESS_KEY: 'dst-key',
	BACKUP_DST_SECRET_KEY: 'dst-secret',
	BACKUP_DST_BUCKET: 'better-backups',
	BACKUP_DATE: '2026-09-05T02-23-00Z'
};

describe('scripts/backup.sh --dry-run', () => {
	it('prints the pg_dump, upload and per-bucket rclone sync commands with retention', async () => {
		const { stdout } = await run('bash', [script, '--dry-run'], { env });
		const lines = stdout.trim().split('\n');

		// Database: custom format, unpooled URL, dated file, 30-day retention.
		expect(lines).toContainEqual(
			expect.stringMatching(
				/^pg_dump --format=custom --no-owner --no-privileges --file=.*sleep-2026-09-05T02-23-00Z\.dump "\$DIRECT_DATABASE_URL"$/
			)
		);
		expect(lines).toContainEqual(
			expect.stringMatching(
				/^rclone copyto .*sleep-2026-09-05T02-23-00Z\.dump dst:better-backups\/sleep\/db\/sleep-2026-09-05T02-23-00Z\.dump$/
			)
		);
		expect(lines).toContainEqual(
			expect.stringMatching(/^rclone delete --min-age 30d dst:better-backups\/sleep\/db$/)
		);

		// Buckets: media synced with a 90-day backup-dir retention, fiscal
		// NEVER expires (the law says keep them) — no delete for it at all.
		expect(lines).toContainEqual(
			'rclone sync src:bettersleep-media dst:better-backups/sleep/media --backup-dir dst:better-backups/sleep/media-deleted/2026-09-05T02-23-00Z'
		);
		expect(lines).toContainEqual(
			'rclone delete --min-age 90d dst:better-backups/sleep/media-deleted'
		);
		expect(lines).toContainEqual(
			'rclone sync src:bettersleep-fiscal dst:better-backups/sleep/fiscal --backup-dir dst:better-backups/sleep/fiscal-deleted/2026-09-05T02-23-00Z'
		);
		expect(
			lines.filter((line) => line.includes('fiscal') && line.startsWith('rclone delete'))
		).toEqual([]);

		// Secrets never appear on the command line (they travel as env).
		expect(stdout).not.toContain('s3cr3t');
		expect(stdout).not.toContain('src-secret');
		expect(stdout).not.toContain('dst-secret');
	});

	it('refuses to run without the destination (a backup to nowhere is a false green)', async () => {
		const { BACKUP_DST_BUCKET: _omitted, ...withoutDestination } = env;
		void _omitted;
		await expect(
			run('bash', [script, '--dry-run'], { env: withoutDestination })
		).rejects.toMatchObject({
			code: 2,
			stderr: expect.stringContaining('BACKUP_DST_BUCKET')
		});
	});
});
