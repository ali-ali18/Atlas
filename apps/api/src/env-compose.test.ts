/**
 * Variável que o código de api/worker lê e o `.env.example` documenta TEM que estar no
 * `x-api-environment` do docker-compose.yml; senão, no Dokploy ela é definida no painel e nunca chega
 * ao container (falha calada). Lê os arquivos e compara.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ENV_GROUPS } from "@workspace/shared";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "evals", "scripts"]);

/** Infra do compose/CLI que o código dos apps não lê (ou que o compose fixa por serviço). */
const NOT_APP_ENV = new Set(["POSTGRES_PASSWORD", "REDIS_PASSWORD"]);

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(entry.name)) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) out.push(path);
	}
	return out;
}

function appCode(): string {
	const dirs = [join(root, "apps", "api", "src"), join(root, "apps", "worker", "src"), join(root, "packages")];
	return dirs.flatMap((dir) => walk(dir)).map((file) => readFileSync(file, "utf8")).join("\n");
}

function documentedVars(): Set<string> {
	const text = readFileSync(join(root, ".env.example"), "utf8");
	return new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]!));
}

function composeApiEnvVars(): Set<string> {
	const text = readFileSync(join(root, "docker-compose.yml"), "utf8").replace(/\r\n/g, "\n");
	const start = text.indexOf("x-api-environment:");
	assert.ok(start >= 0, "x-api-environment não encontrado no docker-compose.yml");
	const block = text.slice(start).split(/\n(?=\S)/)[1] === undefined ? text.slice(start) : text.slice(start).split(/\n(?=\S)/)[0]!;
	return new Set([...block.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]!));
}

test("toda variável usada pelo código de api/worker e documentada no .env.example está no x-api-environment", () => {
	const code = appCode();
	const inCompose = composeApiEnvVars();
	const missing = [...documentedVars()]
		.filter((name) => !NOT_APP_ENV.has(name))
		.filter((name) => new RegExp(`\\b${name}\\b`).test(code))
		.filter((name) => !inCompose.has(name))
		.sort();
	assert.deepEqual(missing, [], `faltam no x-api-environment do docker-compose.yml: ${missing.join(", ")}`);
});

test("toda variável dos grupos de checagem de boot (ENV_GROUPS) chega ao container", () => {
	const inCompose = composeApiEnvVars();
	const missing = ENV_GROUPS.flatMap((group) => group.vars).filter((name) => !inCompose.has(name));
	assert.deepEqual([...new Set(missing)].sort(), []);
});

test("toda variável dos grupos de checagem está documentada no .env.example", () => {
	const documented = documentedVars();
	const missing = ENV_GROUPS.flatMap((group) => group.vars).filter((name) => !documented.has(name));
	assert.deepEqual([...new Set(missing)].sort(), []);
});
