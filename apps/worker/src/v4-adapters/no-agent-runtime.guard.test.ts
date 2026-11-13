/**
 * Guarda da F9.3/F10: os adaptadores do motor v4 no worker não importam o legado (`@workspace/agent-runtime`).
 * A lista de exceções só pode DIMINUIR: ao desacoplar um adaptador, tire-o daqui (o teste também falha se uma exceção
 * já não importa mais o legado, para a lista não ficar com entrada velha).
 * Runner: `NODE_ENV=test ATLAS_HOOK_PEPPER=test-pepper pnpm exec tsx --test src/v4-adapters/no-agent-runtime.guard.test.ts`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
// Montado por concatenação para este arquivo não disparar a própria guarda.
const LEGACY = "@workspace/agent-" + "runtime";

/** Adaptadores que ainda dependem do legado. Só diminui. */
const EXCEPTIONS: readonly string[] = [
	// Cliente MCP inteiro (pool, OAuth, redação, portão do GitHub): `loadMcpRuntime`. Sai com o `packages/mcp` (F10).
	"mcp.ts",
];

const importsLegacy = (code: string): boolean => new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)["']${LEGACY}["']`).test(code);

const adapters = readdirSync(DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".integration.ts"));

test("adaptadores do v4 não importam o agent-runtime, salvo a lista de exceções", () => {
	const offenders = adapters.filter((name) => !EXCEPTIONS.includes(name) && importsLegacy(readFileSync(join(DIR, name), "utf8")));
	assert.deepEqual(offenders, [], `adaptador importa ${LEGACY}: mova a lógica para um pacote neutro (db, shared, google, bot-mail…)`);
});

test("a lista de exceções não guarda entrada velha", () => {
	for (const name of EXCEPTIONS) {
		assert.ok(adapters.includes(name), `${name} não existe mais: tire da lista`);
		assert.ok(importsLegacy(readFileSync(join(DIR, name), "utf8")), `${name} já não importa o legado: tire da lista`);
	}
});

test("a guarda enxerga import estático, dinâmico e reexport", () => {
	assert.ok(importsLegacy(`import { a } from "${LEGACY}";`));
	assert.ok(importsLegacy(`const x = await import("${LEGACY}");`));
	assert.ok(importsLegacy(`export * from "${LEGACY}";`));
	assert.ok(!importsLegacy(`import { a } from "@workspace/db";`));
});
