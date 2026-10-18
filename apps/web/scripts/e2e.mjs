#!/usr/bin/env node
// `pnpm e2e` — E2E mobile (Playwright, 390x844) contra o app em modo dev com a API simulada no navegador.
// Escolhe uma porta livre (nunca 3100/3101/9333), sobe o `next dev` pelo webServer do Playwright e roda.
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN = new Set([3000, 3001, 3100, 3101, 9333]);
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => (FORBIDDEN.has(port) ? freePort().then(resolvePort, reject) : resolvePort(port)));
		});
	});
}

const port = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : await freePort();
if (FORBIDDEN.has(port)) {
	console.error(`[e2e] porta ${port} é reservada; use outra em E2E_PORT.`);
	process.exit(2);
}
console.log(`[e2e] app em modo dev na porta ${port}`);
const result = spawnSync("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
	cwd: webDir,
	stdio: "inherit",
	shell: process.platform === "win32",
	env: { ...process.env, E2E_PORT: String(port), NEXT_TELEMETRY_DISABLED: "1" },
});
process.exit(result.status ?? 1);
