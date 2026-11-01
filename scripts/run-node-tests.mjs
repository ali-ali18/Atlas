#!/usr/bin/env node
// Roda testes node:test via tsx com o ambiente de teste padrão (multiplataforma).
// Uso (no diretório do pacote): node ../../scripts/run-node-tests.mjs "src/**/*.test.ts" [...]
import { spawnSync } from "node:child_process";

// Flags do node:test (`--test-concurrency=1` etc.) passam adiante; o resto são globs.
const args = process.argv.slice(2);
const testFlags = args.filter((arg) => arg.startsWith("--test-"));
const patterns = args.filter((arg) => !arg.startsWith("--test-"));
if (patterns.length === 0) {
	console.error("uso: run-node-tests.mjs <glob> [<glob>...]");
	process.exit(2);
}
const env = {
	...process.env,
	NODE_ENV: "test",
	ATLAS_HOOK_PEPPER: process.env.ATLAS_HOOK_PEPPER || "test-pepper",
	ATLAS_OWNER_EMAIL: process.env.ATLAS_OWNER_EMAIL || "owner@example.com",
	BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || "test-secret-test-secret-test-secret-00",
};
const result = spawnSync(
	process.execPath,
	["--import", "tsx", "--test", ...testFlags, ...patterns],
	{ stdio: "inherit", env },
);
process.exit(result.status ?? 1);
