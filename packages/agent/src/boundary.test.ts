import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guarda de fronteira (03 §0): o motor v4 é base nova e não depende do legado.
// As amostras dos auto-testes são montadas por concatenação para o próprio
// arquivo não disparar a guarda que ele testa.

const SRC = dirname(fileURLToPath(import.meta.url));
const ADAPTERS = join(SRC, "adapters") + sep;
const RUNTIME_NAME = "@workspace/agent-" + "runtime";
const ENV_ACCESS = "process" + ".env";

function listTs(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) return listTs(full);
		return full.endsWith(".ts") ? [full] : [];
	});
}

/** Especificadores de import estático, dinâmico, re-export e require. */
export function importSpecifiers(code: string): string[] {
	const found: string[] = [];
	const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
	for (const m of code.matchAll(pattern)) found.push(m[1] as string);
	return found;
}

export function isForbiddenImport(spec: string, fromFile: string): boolean {
	if (spec === RUNTIME_NAME || spec.startsWith(`${RUNTIME_NAME}/`)) return true;
	if (spec.startsWith(".")) {
		const target = relative(SRC, resolve(dirname(fromFile), spec)).split(sep);
		return resolve(dirname(fromFile), spec).includes(`${sep}agent-runtime`) || target.includes("agent-runtime");
	}
	return /(^|\/)packages\/agent-runtime(\/|$)/.test(spec);
}

/** Pacotes do workspace que o motor v4 pode declarar: só o transporte de modelo e os tipos/funções puras. Todo o resto (db, queue, sandbox, agent-runtime…) chega por porta injetada. */
export const ALLOWED_WORKSPACE_DEPS: readonly string[] = ["@workspace/llm", "@workspace/shared", "@workspace/typescript-config"];

/** Dependências de `@workspace/*` declaradas no package.json que não estão na lista permitida (inclui o agent-runtime). */
export function forbiddenManifestDeps(manifest: Record<string, unknown>): string[] {
	const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
	return sections.flatMap((section) => {
		const deps = manifest[section];
		if (typeof deps !== "object" || deps === null) return [];
		return Object.keys(deps).filter((name) => (name.startsWith("@workspace/") || name === "agent-runtime") && !ALLOWED_WORKSPACE_DEPS.includes(name)).map((name) => `${section}: ${name}`);
	});
}

export function usesEnv(code: string): boolean {
	return code.includes(ENV_ACCESS);
}

describe("fronteira do motor v4", () => {
	const files = listTs(SRC);

	it("encontra arquivos para varrer", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it("nenhum arquivo importa o agent-runtime (v1/v2/v3)", () => {
		const bad = files.flatMap((file) =>
			importSpecifiers(readFileSync(file, "utf8"))
				.filter((spec) => isForbiddenImport(spec, file))
				.map((spec) => `${relative(SRC, file)} -> ${spec}`),
		);
		expect(bad).toEqual([]);
	});

	it("o package.json não declara o agent-runtime nem outro pacote do workspace fora da lista permitida (auditoria F1, T3)", () => {
		const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as Record<string, unknown>;
		expect(forbiddenManifestDeps(manifest)).toEqual([]);
		expect(JSON.stringify(manifest)).not.toContain(RUNTIME_NAME);
	});

	it("variáveis de ambiente só em src/adapters/ (configuração chega injetada)", () => {
		const bad = files
			.filter((file) => !file.startsWith(ADAPTERS))
			.filter((file) => usesEnv(readFileSync(file, "utf8")))
			.map((file) => relative(SRC, file));
		expect(bad).toEqual([]);
	});

	describe("auto-teste dos detectores", () => {
		const from = join(SRC, "kernel", "x.ts");
		it("pega import do pacote do legado", () => {
			const code = `import { a } from "${RUNTIME_NAME}";\nexport * from '${RUNTIME_NAME}/files';`;
			const specs = importSpecifiers(code);
			expect(specs).toHaveLength(2);
			expect(specs.every((s) => isForbiddenImport(s, from))).toBe(true);
		});
		it("pega import dinâmico e require", () => {
			const code = `await import("${RUNTIME_NAME}");\nrequire('${RUNTIME_NAME}')`;
			expect(importSpecifiers(code).every((s) => isForbiddenImport(s, from))).toBe(true);
		});
		it("pega caminho relativo para packages/agent-runtime", () => {
			expect(isForbiddenImport("../../../agent-runtime/src/index.js", from)).toBe(true);
			expect(isForbiddenImport("../../agent-runtime", from)).toBe(true);
		});
		it("deixa passar imports legítimos", () => {
			expect(isForbiddenImport("@workspace/shared", from)).toBe(false);
			expect(isForbiddenImport("./ports/index.js", from)).toBe(false);
			expect(isForbiddenImport("node:fs", from)).toBe(false);
		});
		it("pega dependência proibida no package.json, em qualquer seção", () => {
			expect(forbiddenManifestDeps({ dependencies: { [RUNTIME_NAME]: "workspace:*" } })).toEqual([`dependencies: ${RUNTIME_NAME}`]);
			expect(forbiddenManifestDeps({ devDependencies: { "@workspace/db": "workspace:*" }, peerDependencies: { "@workspace/queue": "*" } })).toEqual(["devDependencies: @workspace/db", "peerDependencies: @workspace/queue"]);
			expect(forbiddenManifestDeps({ dependencies: { "@workspace/llm": "workspace:*", "@workspace/shared": "workspace:*", zod: "^4" }, devDependencies: { "@workspace/typescript-config": "workspace:*" } })).toEqual([]);
		});
		it("pega uso de env e ignora código limpo", () => {
			expect(usesEnv(`const k = ${ENV_ACCESS}.KEY;`)).toBe(true);
			expect(usesEnv("const k = config.key;")).toBe(false);
		});
	});
});
