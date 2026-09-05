import { describe, expect, it } from 'vitest';
import { resolvePasswordInput } from './password-input.ts';

/**
 * FIX-16 (audit "Secrets on the command line"): `user:create --password …`
 * puts a staff password into shell history and `ps`. The script now reads
 * it from stdin (`--password-stdin`), or prompts on a TTY, and REFUSES
 * `--password` when stdin is a terminal — a human typing it into a
 * terminal is exactly the case that leaks. Non-interactive callers (the
 * dry-run script, a provisioning job) may still pass it explicitly.
 */
describe('resolvePasswordInput', () => {
	it('--password-stdin reads one line from stdin and trims the newline', async () => {
		const password = await resolvePasswordInput({
			passwordStdin: true,
			isTTY: false,
			readStdin: async () => 'correct horse battery staple\n',
			prompt: async () => {
				throw new Error('must not prompt');
			}
		});
		expect(password).toBe('correct horse battery staple');
	});

	it('prompts (no echo) on a TTY when nothing was passed', async () => {
		const password = await resolvePasswordInput({
			isTTY: true,
			readStdin: async () => {
				throw new Error('must not read stdin');
			},
			prompt: async (label) => {
				expect(label).toMatch(/password/i);
				return 'typed-at-the-prompt';
			}
		});
		expect(password).toBe('typed-at-the-prompt');
	});

	it('refuses --password on a TTY (shell history, ps)', async () => {
		await expect(
			resolvePasswordInput({
				password: 'leaks-into-history',
				isTTY: true,
				readStdin: async () => '',
				prompt: async () => ''
			})
		).rejects.toThrow(/--password-stdin/);
	});

	it('accepts --password from a non-interactive caller', async () => {
		await expect(
			resolvePasswordInput({
				password: 'from-a-script',
				isTTY: false,
				readStdin: async () => '',
				prompt: async () => ''
			})
		).resolves.toBe('from-a-script');
	});

	it('rejects an empty result from any source', async () => {
		await expect(
			resolvePasswordInput({
				passwordStdin: true,
				isTTY: false,
				readStdin: async () => '\n',
				prompt: async () => ''
			})
		).rejects.toThrow(/empty/);
	});
});
