import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Checagem de código-fonte (não de texto de usuário): o motor v2 não pode depender do laço v1
// (`computer-use.ts`), para o harness v3 nascer sem esse acoplamento. Testes do v2 podem importar o
// entrypoint v1 para comparar comportamento; só o código de produção é vigiado.
const dir = dirname(fileURLToPath(import.meta.url));

function sourceFiles(): string[] {
	return readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
}

/** Especificadores de `import ... from "x"`, `export ... from "x"` e `import("x")`. */
function moduleSpecifiers(code: string): string[] {
	const specifiers: string[] = [];
	for (const match of code.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
		specifiers.push(match[1] ?? match[2] ?? "");
	}
	return specifiers;
}

describe("independência do motor v2 em relação ao v1", () => {
	it("encontra os arquivos do motor v2", () => {
		expect(sourceFiles().length).toBeGreaterThan(5);
	});

	it("nenhum arquivo de produção do engine-v2 importa de computer-use", () => {
		const offenders = sourceFiles().filter((name) =>
			moduleSpecifiers(readFileSync(join(dir, name), "utf8")).some((specifier) => /(^|\/)computer-use(\.js)?$/.test(specifier)),
		);
		expect(offenders).toEqual([]);
	});
});
