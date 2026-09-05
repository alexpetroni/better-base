/**
 * Where a CLI script gets a password from (FIX-16, audit "Secrets on the
 * command line"). Preference order:
 *   1. `--password-stdin` — one line from stdin (`printf '%s\n' "$PW" |
 *      pnpm user:create -- --password-stdin …`), trailing newline stripped;
 *   2. an explicit `--password` — allowed only when stdin is NOT a
 *      terminal (a provisioning script), refused on a TTY where it would
 *      land in shell history and `ps`;
 *   3. otherwise, on a TTY, a no-echo prompt.
 * Framework-free: the readers are injected so the rules are unit-testable.
 */
export interface PasswordInputOptions {
	password?: string;
	passwordStdin?: boolean;
	isTTY: boolean;
	readStdin: () => Promise<string>;
	prompt: (label: string) => Promise<string>;
}

export async function resolvePasswordInput(opts: PasswordInputOptions): Promise<string> {
	let value: string;
	if (opts.passwordStdin) {
		value = (await opts.readStdin()).replace(/\r?\n$/, '');
	} else if (opts.password !== undefined) {
		if (opts.isTTY) {
			throw new Error(
				'--password on a terminal lands in shell history and `ps` — use --password-stdin (pipe it) or omit it to be prompted'
			);
		}
		value = opts.password;
	} else if (opts.isTTY) {
		value = await opts.prompt('Password (no echo): ');
	} else {
		throw new Error(
			'no password: pass --password-stdin (piped) or run on a terminal to be prompted'
		);
	}
	if (!value) throw new Error('password is empty');
	return value;
}
