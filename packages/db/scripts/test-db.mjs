#!/usr/bin/env node
// `pnpm test:db` — roda os testes do pacote contra um Postgres+pgvector de verdade.
//
// - Sem ATLAS_TEST_DB_URL: sobe um container efêmero (pgvector/pgvector:pg16, porta livre
//   aleatória; nunca 3100/3101/9333), aplica `prisma migrate deploy` e o remove no fim.
// - Com ATLAS_TEST_DB_URL (ex.: service container do CI): usa esse banco (o nome deve conter "test").
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN_PORTS = new Set([3100, 3101, 9333]);
const IMAGE = process.env.ATLAS_TEST_DB_IMAGE || "pgvector/pgvector:pg16";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => (FORBIDDEN_PORTS.has(port) ? freePort().then(resolvePort, reject) : resolvePort(port)));
		});
	});
}

function docker(args, opts = {}) {
	return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

let container = null;
function cleanup() {
	if (!container) return;
	try {
		docker(["rm", "-f", container]);
	} catch {}
	container = null;
}
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		cleanup();
		process.exit(130);
	});
}

async function main() {
	let url = process.env.ATLAS_TEST_DB_URL;
	if (!url) {
		try {
			docker(["info", "--format", "{{.ServerVersion}}"]);
		} catch {
			console.error(
				"[test:db] docker indisponível (daemon parado?). Suba o Docker ou defina ATLAS_TEST_DB_URL apontando para um Postgres com pgvector (nome do banco contendo 'test').",
			);
			return 2;
		}
		const port = await freePort();
		const name = `atlas-test-db-${process.pid}`;
		console.log(`[test:db] subindo ${IMAGE} na porta ${port}...`);
		container = docker([
			"run", "-d", "--rm", "--name", name,
			"-e", "POSTGRES_PASSWORD=test", "-e", "POSTGRES_DB=atlas_test", "-e", "POSTGRES_USER=test",
			"-p", `127.0.0.1:${port}:5432`, IMAGE,
		]).slice(0, 12);
		container = name;
		url = `postgresql://test:test@127.0.0.1:${port}/atlas_test`;
		let ready = false;
		for (let i = 0; i < 60 && !ready; i++) {
			try {
				docker(["exec", name, "pg_isready", "-U", "test", "-d", "atlas_test", "-h", "127.0.0.1"]);
				// o init do postgres reinicia uma vez; confirma com uma consulta real
				docker(["exec", name, "psql", "-U", "test", "-d", "atlas_test", "-h", "127.0.0.1", "-tAc", "select 1"]);
				ready = true;
			} catch {
				await sleep(1000);
			}
		}
		if (!ready) {
			console.error("[test:db] Postgres não ficou pronto a tempo.");
			return 1;
		}
	}
	if (!/test/i.test(new URL(url).pathname)) {
		console.error("[test:db] recusado: o nome do banco de teste precisa conter 'test'.");
		return 2;
	}
	const env = { ...process.env, ATLAS_TEST_DB_URL: url, DATABASE_URL: url };
	console.log("[test:db] migrations do zero + smoke...");
	const migrate = spawnSync(process.execPath, [resolve(pkgDir, "scripts/migrations-smoke.mjs")], { cwd: pkgDir, env, stdio: "inherit" });
	if (migrate.status !== 0) return migrate.status ?? 1;
	console.log("[test:db] rodando testes...");
	const run = spawnSync(process.execPath, [resolve(pkgDir, "../../scripts/run-node-tests.mjs"), "src/**/*.test.ts"], {
		cwd: pkgDir, env, stdio: "inherit",
	});
	return run.status ?? 1;
}

main()
	.then((code) => {
		cleanup();
		process.exit(code);
	})
	.catch((error) => {
		console.error(error);
		cleanup();
		process.exit(1);
	});
