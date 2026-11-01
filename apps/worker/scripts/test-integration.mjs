#!/usr/bin/env node
// `pnpm --filter worker test:integration` — testes de integração do agente (Postgres real, modelo roteirizado).
// Sem ATLAS_TEST_DB_URL: avisa e sai com 0 (não quebra quem roda só o `test`). Ver docs/testes-integracao.md.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const url = process.env.ATLAS_TEST_DB_URL?.trim();
if (!url) {
	console.log("[test:integration] PULADO: defina ATLAS_TEST_DB_URL (Postgres com pgvector, migrations aplicadas, nome do banco contendo 'test'). Ver docs/testes-integracao.md.");
	process.exit(0);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const result = spawnSync(
	process.execPath,
	// Um arquivo por vez: todos dividem o mesmo banco, e o despacho de grupo (`processGroupTurnsAndPending`) pega
	// turnos abertos de qualquer dono; dois arquivos em paralelo roubam o trabalho um do outro.
	[resolve(root, "scripts/run-node-tests.mjs"), "--test-concurrency=1", "src/integration/*.integration.ts"],
	{ stdio: "inherit", env: { ...process.env, DATABASE_URL: url } },
);
process.exit(result.status ?? 1);
