/**
 * A API só valida e grava anexos; ler PDF/Office/planilha é trabalho do worker (pool de worker
 * threads). Este teste garante, pelo grafo de imports estáticos, que nada que a API carrega puxa
 * pdf.js, exceljs, mammoth nem os parsers (`extract-core`, `extract-thread`).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeSrc = resolve(here, "../../../packages/agent-runtime/src");
const HEAVY = /^(pdfjs-dist|exceljs|mammoth)(\/|$)/;
const PARSERS = /(^|\/)extract-(core|thread)(\.js|\.ts)?$/;

/** Imports estáticos (`import ... from "x"`, `export ... from "x"`, `import "x"`); `import("x")` tardio fica de fora. */
function staticImports(source: string): string[] {
	const found: string[] = [];
	for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm)) found.push(match[1]!);
	return found;
}

function resolveRelative(from: string, spec: string): string | null {
	const base = resolve(dirname(from), spec);
	for (const candidate of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return null;
}

function reachable(entry: string): Map<string, string[]> {
	const seen = new Map<string, string[]>();
	const queue = [entry];
	while (queue.length) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		const specs = staticImports(readFileSync(file, "utf8"));
		seen.set(file, specs);
		for (const spec of specs) {
			if (!spec.startsWith(".")) continue;
			const next = resolveRelative(file, spec);
			if (next) queue.push(next);
		}
	}
	return seen;
}

test("o entry do agent-runtime (importado pela API) não alcança parsers de anexo", () => {
	const graph = reachable(join(runtimeSrc, "index.ts"));
	assert.ok(graph.size > 50, "o grafo deveria cobrir o runtime inteiro");
	const offenders: string[] = [];
	for (const [file, specs] of graph) {
		for (const spec of specs) {
			if (HEAVY.test(spec) || PARSERS.test(spec)) offenders.push(`${file.replace(runtimeSrc, "")} -> ${spec}`);
		}
	}
	assert.deepEqual(offenders, []);
});

test("nenhum arquivo da API importa parsers de anexo, nem os declara como dependência", () => {
	const offenders: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.tsx?$/.test(name) && !/\.test\.ts$/.test(name)) {
				for (const spec of staticImports(readFileSync(path, "utf8"))) if (HEAVY.test(spec) || PARSERS.test(spec)) offenders.push(`${path} -> ${spec}`);
			}
		}
	};
	walk(here);
	assert.deepEqual(offenders, []);
	const pkg = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as { dependencies?: Record<string, string> };
	assert.deepEqual(Object.keys(pkg.dependencies ?? {}).filter((name) => HEAVY.test(name)), []);
});

test("o grafo detecta import pesado (sanidade do teste)", () => {
	const sample = ['import type T from "mammoth";', 'import ExcelJS from "exceljs";', 'export { a } from "./x.js";', 'const m = await import("mammoth");'].join("\n");
	assert.deepEqual(staticImports(sample), ["exceljs", "./x.js"]);
});
