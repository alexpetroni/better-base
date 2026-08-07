import net from 'node:net';
import path from 'node:path';
import { config } from 'dotenv';

// Integration tests read TEST_DATABASE_URL from the repo-root .env.
config({ path: path.resolve(import.meta.dirname, '../../../.env') });

// `pnpm test:neon` (DB_DRIVER=neon) runs the whole suite over the local
// Neon-protocol proxy. If that proxy is not up, every DB spec would drown in
// per-connection timeouts — fail loudly here instead, with the fix in the
// message. NEVER a skip: a neon run that silently fell back to nothing would
// be a pg-driver test wearing a neon label.
if (process.env.DB_DRIVER === 'neon') {
	const proxy = process.env.NEON_WS_PROXY;
	if (!proxy) {
		throw new Error(
			'DB_DRIVER=neon but NEON_WS_PROXY is unset. Tests reach the Neon protocol via the local ' +
				'wsproxy — run `pnpm test:neon` (it sets NEON_WS_PROXY), or point it at a proxy yourself.'
		);
	}
	const [host, port] = proxy.split(':');
	await new Promise<void>((resolve, reject) => {
		const unreachable = (why: string) =>
			reject(
				new Error(
					`The local Neon proxy at ${proxy} is not reachable (${why}). ` +
						'Start it with: docker compose --profile neon up -d --build  (see DEPLOYMENT.md §12)'
				)
			);
		const socket = net.connect({ host, port: Number(port), timeout: 2_000 });
		socket.once('connect', () => {
			socket.destroy();
			resolve();
		});
		socket.once('error', (err) => unreachable(err.message));
		socket.once('timeout', () => {
			socket.destroy();
			unreachable('connect timeout');
		});
	});
}
